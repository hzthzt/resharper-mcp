using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using JetBrains.Application.Progress;
using JetBrains.ProjectModel;
using JetBrains.ReSharper.Feature.Services.Bulbs;
using JetBrains.ReSharper.Feature.Services.Daemon;
using JetBrains.ReSharper.Feature.Services.Intentions.Scoped.Actions;
using JetBrains.ReSharper.Feature.Services.Intentions.Scoped.Scopes;
using JetBrains.ReSharper.Feature.Services.QuickFixes;
using JetBrains.ReSharper.Psi;
using Newtonsoft.Json.Linq;

namespace ReSharperMcp.Tools
{
    /// <summary>
    /// Applies ReSharper inspection quick-fixes across a whole file headlessly, by inspection id —
    /// e.g. converting every explicit constructor into a primary constructor. Drives ReSharper's own
    /// "Fix all in file" engine: for each chosen inspection it runs the scoped quick-fix, which rewrites
    /// every occurrence and re-analyzes until stable.
    ///
    /// Complements <see cref="ApplyQuickFixTool"/> (apply_quick_fix), which applies a single bulb action at a
    /// position. This tool is position-free and file-wide. Only scoped fixes (<see cref="IModernManualScopedAction"/>)
    /// can run this way; non-scoped fixes are reported as skipped — use apply_quick_fix for those.
    ///
    /// Self-transacting: the scoped executor manages its own PSI transactions.
    /// Shares <see cref="DaemonHighlightingCollector"/> with get_diagnostics / list_quick_fixes.
    /// </summary>
    public class ApplySuggestionsTool : IMcpSelfTransactingWriteTool
    {
        // Upper bound on distinct fix types applied per file — a safety net against a fix that never clears its highlighting.
        private const int MaxFixTypesPerFile = 50;

        private readonly ISolution _solution;

        public ApplySuggestionsTool(ISolution solution) => _solution = solution;

        public string Name => "apply_suggestions";

        public string Description =>
            "Apply ReSharper suggestion quick-fixes across a whole file by inspection id (e.g. convert every " +
            "explicit constructor to a primary constructor). Position-free and file-wide — complements " +
            "apply_quick_fix, which applies one fix at a specific position. Run get_diagnostics first to discover " +
            "inspection ids. Specify which to apply via 'inspectionIds', or pass all=true to apply every applicable " +
            "suggestion. Each chosen fix rewrites all its occurrences and re-analyzes until stable. Only headlessly-" +
            "applicable (scoped) fixes are applied; others are reported as skipped. Pass dryRun=true to preview " +
            "without modifying the file. Pass multiple files via the 'filePaths' array.";

        public object InputSchema => new
        {
            type = "object",
            properties = new
            {
                filePath = new
                {
                    type = "string",
                    description = "Absolute path to the file to apply suggestions to"
                },
                filePaths = new
                {
                    type = "array",
                    description = "Array of absolute file paths to process in batch. Results are concatenated with separators. Alternative to single 'filePath' parameter.",
                    items = new { type = "string" }
                },
                inspectionIds = new
                {
                    type = "string",
                    description = "Comma-separated inspection ids to apply (e.g. 'ConvertToPrimaryConstructor'). Use get_diagnostics to discover ids."
                },
                all = new
                {
                    type = "boolean",
                    description = "Apply every applicable (scoped) suggestion in the file. Ignored when 'inspectionIds' is set. Default: false."
                },
                dryRun = new
                {
                    type = "boolean",
                    description = "Report what would be applied without modifying the file. Default: false."
                }
            },
            required = new string[0]
        };

        public object Execute(JObject arguments)
        {
            var filePathsToken = arguments["filePaths"] as JArray;
            if (filePathsToken != null && filePathsToken.Count > 0)
            {
                var sb = new StringBuilder();
                for (var i = 0; i < filePathsToken.Count; i++)
                {
                    if (i > 0) sb.AppendLine().AppendLine();
                    var itemArgs = new JObject { ["filePath"] = filePathsToken[i]?.ToString() };
                    CopyIfPresent(arguments, itemArgs, "inspectionIds");
                    CopyIfPresent(arguments, itemArgs, "all");
                    CopyIfPresent(arguments, itemArgs, "dryRun");

                    sb.Append("=== [").Append(i + 1).Append('/').Append(filePathsToken.Count)
                      .Append("] ").Append(filePathsToken[i]).Append(" ===").AppendLine();
                    sb.Append(ResultToString(ExecuteSingle(itemArgs)));
                }
                return sb.ToString().TrimEnd();
            }

            return ExecuteSingle(arguments);
        }

        private object ExecuteSingle(JObject arguments)
        {
            var filePath = arguments["filePath"]?.ToString();
            if (string.IsNullOrEmpty(filePath))
                return new { error = "filePath is required" };

            var idFilter = ParseCsv(arguments["inspectionIds"]?.ToString());
            var applyAll = arguments["all"]?.Value<bool>() ?? false;
            var dryRun = arguments["dryRun"]?.Value<bool>() ?? false;

            if (idFilter == null && !applyAll)
                return ListApplicable(filePath);

            var sourceFile = PsiHelpers.GetSourceFile(_solution, filePath);
            if (sourceFile == null)
                return new { error = $"File not found in solution: {filePath}" };

            var settingsManager = _solution.GetComponent<HighlightingSettingsManager>();
            var quickFixTable = _solution.GetComponent<QuickFixTable>();

            if (dryRun)
                return DescribeDryRun(filePath, sourceFile, settingsManager, quickFixTable, idFilter, applyAll);

            var applied = new List<string>();
            var skipped = new HashSet<string>();
            var errors = new List<string>();
            var handledTypes = new HashSet<string>();

            // Re-collect on every pass: applying one fix invalidates the previous highlightings, so each
            // iteration starts from a fresh daemon run and picks the next not-yet-applied scoped fix type.
            for (var iteration = 0; iteration < MaxFixTypesPerFile; iteration++)
            {
                Pick pick = null;
                foreach (var info in DaemonHighlightingCollector.Collect(_solution, sourceFile))
                {
                    var inspectionId = GetInspectionId(settingsManager, info.Highlighting);
                    if (!Matches(inspectionId, idFilter, applyAll))
                        continue;

                    foreach (var instance in EnumerateFixes(quickFixTable, info))
                    {
                        if (!(instance.QuickFix is IModernManualScopedAction scoped))
                        {
                            if (inspectionId != null)
                                skipped.Add(inspectionId);
                            continue;
                        }

                        var typeName = instance.QuickFix.GetType().FullName;
                        if (handledTypes.Contains(typeName))
                            continue;

                        pick = new Pick
                        {
                            Scoped = scoped,
                            Highlighting = info.Highlighting,
                            InspectionId = inspectionId,
                            TypeName = typeName,
                            FixText = FixText(instance)
                        };
                        break;
                    }

                    if (pick != null)
                        break;
                }

                if (pick == null)
                    break;

                handledTypes.Add(pick.TypeName);
                try
                {
                    pick.Scoped.ExecuteAction(
                        _solution, new SourceFileScope(sourceFile), pick.Highlighting,
                        NullProgressIndicator.Create());
                    applied.Add($"{pick.InspectionId ?? "(no id)"} — \"{pick.FixText}\"");
                    _solution.GetPsiServices().Caches.Update();
                }
                catch (Exception ex)
                {
                    errors.Add($"{pick.InspectionId ?? "(no id)"}: {ex.Message}");
                }
            }

            return FormatResult(filePath, applied, skipped, errors);
        }

        // No filter given — list the applicable inspection ids so the caller can choose.
        private object ListApplicable(string filePath)
        {
            var sourceFile = PsiHelpers.GetSourceFile(_solution, filePath);
            if (sourceFile == null)
                return new { error = $"File not found in solution: {filePath}" };

            var settingsManager = _solution.GetComponent<HighlightingSettingsManager>();
            var quickFixTable = _solution.GetComponent<QuickFixTable>();
            var ids = ApplicableIds(sourceFile, settingsManager, quickFixTable);

            var sb = new StringBuilder();
            sb.Append(filePath).AppendLine(" — specify 'inspectionIds' or pass all=true.");
            if (ids.Count > 0)
            {
                sb.AppendLine().AppendLine("applicable inspection ids in this file:");
                foreach (var id in ids.OrderBy(x => x))
                    sb.Append("  ").AppendLine(id);
            }
            else
            {
                sb.AppendLine().AppendLine("no applicable (scoped) suggestions found.");
            }

            return sb.ToString().TrimEnd();
        }

        private object DescribeDryRun(
            string filePath, IPsiSourceFile sourceFile, HighlightingSettingsManager settingsManager,
            QuickFixTable quickFixTable, HashSet<string> idFilter, bool applyAll)
        {
            var wouldApply = new List<string>();
            var seenTypes = new HashSet<string>();
            foreach (var info in DaemonHighlightingCollector.Collect(_solution, sourceFile))
            {
                var inspectionId = GetInspectionId(settingsManager, info.Highlighting);
                if (!Matches(inspectionId, idFilter, applyAll))
                    continue;

                foreach (var instance in EnumerateFixes(quickFixTable, info))
                {
                    if (!(instance.QuickFix is IModernManualScopedAction))
                        continue;
                    if (!seenTypes.Add(instance.QuickFix.GetType().FullName))
                        continue;
                    wouldApply.Add($"{inspectionId ?? "(no id)"} — \"{FixText(instance)}\"");
                }
            }

            if (wouldApply.Count == 0)
                return $"{filePath} — dry run: nothing to apply";

            var sb = new StringBuilder();
            sb.Append(filePath).Append(" — dry run: would apply ").Append(wouldApply.Count).AppendLine(" fix type(s):");
            foreach (var entry in wouldApply)
                sb.Append("  ").AppendLine(entry);
            return sb.ToString().TrimEnd();
        }

        private HashSet<string> ApplicableIds(
            IPsiSourceFile sourceFile, HighlightingSettingsManager settingsManager, QuickFixTable quickFixTable)
        {
            var ids = new HashSet<string>();
            foreach (var info in DaemonHighlightingCollector.Collect(_solution, sourceFile))
            {
                var inspectionId = GetInspectionId(settingsManager, info.Highlighting);
                if (inspectionId == null)
                    continue;
                foreach (var instance in EnumerateFixes(quickFixTable, info))
                {
                    if (instance.QuickFix is IModernManualScopedAction)
                    {
                        ids.Add(inspectionId);
                        break;
                    }
                }
            }

            return ids;
        }

        private static IEnumerable<QuickFixInstance> EnumerateFixes(QuickFixTable quickFixTable, HighlightingInfo info)
        {
            if (info?.Highlighting == null)
                return Enumerable.Empty<QuickFixInstance>();
            try
            {
                var instances = quickFixTable.EnumerateAvailableQuickFixes(info);
                return instances == null ? Enumerable.Empty<QuickFixInstance>() : instances.Where(i => i?.QuickFix != null).ToList();
            }
            catch (Exception)
            {
                // A fix's availability check can throw on unusual highlightings — treat as no fixes.
                return Enumerable.Empty<QuickFixInstance>();
            }
        }

        // Configurable inspection id (e.g. "ConvertToPrimaryConstructor"), or null if the highlighting has none.
        private static string GetInspectionId(HighlightingSettingsManager settingsManager, IHighlighting highlighting)
        {
            if (highlighting == null)
                return null;
            if (highlighting is ICustomConfigurableSeverityIdHighlighting custom &&
                !string.IsNullOrEmpty(custom.ConfigurableSeverityId))
                return custom.ConfigurableSeverityId;

            var attribute = settingsManager.GetHighlightingAttribute(highlighting);
            return (attribute as ConfigurableSeverityHighlightingAttribute)?.ConfigurableSeverityId;
        }

        private static bool Matches(string inspectionId, HashSet<string> idFilter, bool applyAll)
        {
            if (applyAll)
                return true;
            return inspectionId != null && idFilter.Contains(inspectionId);
        }

        private static string FixText(QuickFixInstance instance)
        {
            if (instance.QuickFix is IBulbAction bulb && !string.IsNullOrEmpty(bulb.Text))
                return bulb.Text;
            return instance.QuickFix.GetType().Name;
        }

        private static object FormatResult(string filePath, List<string> applied, HashSet<string> skipped, List<string> errors)
        {
            var sb = new StringBuilder();
            sb.Append(filePath).Append(" — applied ").Append(applied.Count).AppendLine(" fix type(s)");

            if (applied.Count > 0)
            {
                sb.AppendLine();
                foreach (var entry in applied)
                    sb.Append("  ✓ ").AppendLine(entry);
            }

            if (skipped.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("skipped (not headlessly applicable — try apply_quick_fix at a position):");
                foreach (var id in skipped.OrderBy(x => x))
                    sb.Append("  ").AppendLine(id);
            }

            if (errors.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine("errors:");
                foreach (var error in errors)
                    sb.Append("  ").AppendLine(error);
            }

            return sb.ToString().TrimEnd();
        }

        private static HashSet<string> ParseCsv(string csv)
        {
            if (string.IsNullOrWhiteSpace(csv))
                return null;
            return new HashSet<string>(
                csv.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0),
                StringComparer.OrdinalIgnoreCase);
        }

        private static void CopyIfPresent(JObject source, JObject target, string key)
        {
            var token = source[key];
            if (token != null) target[key] = token;
        }

        private static string ResultToString(object result)
        {
            if (result is string s) return s;
            var jo = JObject.FromObject(result);
            return "error: " + (jo["error"]?.ToString() ?? result.ToString());
        }

        private sealed class Pick
        {
            public IModernManualScopedAction Scoped;
            public IHighlighting Highlighting;
            public string InspectionId;
            public string TypeName;
            public string FixText;
        }
    }
}
