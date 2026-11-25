using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Automation;
using System.Windows.Forms;

namespace ComputerUia;

internal static class Program
{
    private const int DefaultMaxNodes = 500;
    private const int MaximumOwnershipDepth = 4096;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = false
    };

    [STAThread]
    private static int Main()
    {
        Console.InputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Console.OutputEncoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);
        Application.EnableVisualStyles();
        WindowsFormsSynchronizationContext.AutoInstall = true;

        var assistant = new UiaAssistant();
        using var messageLoopAnchor = new Control();
        _ = messageLoopAnchor.Handle;
        SynchronizationContext? uiContext = SynchronizationContext.Current;
        if (uiContext is null)
        {
            return 1;
        }

        int exitCode = 0;
        var inputThread = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    string? line = Console.In.ReadLine();
                    if (line is null)
                    {
                        uiContext.Post(_ =>
                        {
                            assistant.Dispose();
                            Application.ExitThread();
                        }, null);
                        return;
                    }

                    bool shouldExit = false;
                    uiContext.Send(_ => shouldExit = assistant.ProcessLine(line), null);
                    if (shouldExit)
                    {
                        uiContext.Post(_ => Application.ExitThread(), null);
                        return;
                    }
                }
            }
            catch (Exception)
            {
                Volatile.Write(ref exitCode, 1);
                uiContext.Post(_ => Application.ExitThread(), null);
            }
        })
        {
            IsBackground = true,
            Name = "computer-uia-stdin"
        };

        inputThread.Start();
        try
        {
            // A real STA message loop is required for SendKeys journal playback. All UIA/ref operations
            // are marshalled here and remain sequential; only the blocking stdin read runs in parallel.
            Application.Run(new ApplicationContext());
        }
        catch (Exception)
        {
            Volatile.Write(ref exitCode, 1);
        }
        finally
        {
            assistant.Dispose();
        }

        inputThread.Join(1000);
        return exitCode;
    }

    private sealed class UiaAssistant
    {
        private readonly Dictionary<WindowKey, WindowEntry> windows = new();
        private readonly Dictionary<string, WindowEntry> windowRefs = new(StringComparer.Ordinal);
        private readonly Dictionary<string, ElementEntry> elements = new();
        private int nextWindowRef;
        private int nextElementRef;
        private bool disposed;

        public bool ProcessLine(string line)
        {
            if (disposed)
            {
                WriteError("disposed", "The assistant has been disposed.");
                return false;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(line);
            }
            catch (JsonException)
            {
                WriteError("invalid_json", "The request is not valid JSON.");
                return false;
            }

            using (document)
            {
                JsonElement request = document.RootElement;
                if (request.ValueKind != JsonValueKind.Object ||
                    !TryGetString(request, "command", out string? command) ||
                    string.IsNullOrWhiteSpace(command))
                {
                    WriteError("invalid_request", "Expected an object with a non-empty string 'command'.");
                    return false;
                }

                try
                {
                    return command switch
                    {
                        "list_windows" => ListWindows(request),
                        "snapshot" => Snapshot(request),
                        "invoke" => Invoke(request),
                        "set_value" => SetValue(request),
                        "key" => Key(request),
                        "foreground" => Foreground(request),
                        "dispose" => Dispose(request),
                        _ => Reject("unknown_command", $"Unknown command: {command}")
                    };
                }
                catch (UiaException exception)
                {
                    WriteError(exception.Code, exception.Message);
                    return false;
                }
                catch (Exception exception) when (IsUiaOrAutomationException(exception))
                {
                    WriteError("uia_error", SafeMessage(exception, "The UI Automation operation failed."));
                    return false;
                }
                catch (Exception exception)
                {
                    WriteError("internal_error", SafeMessage(exception, "The assistant encountered an internal error."));
                    return false;
                }
            }
        }

        private bool ListWindows(JsonElement request)
        {
            RejectUnknownFields(request, "command");

            var result = new List<Dictionary<string, object?>>();
            foreach (WindowCandidate window in FindTopLevelWindows())
            {
                WindowEntry entry = GetOrCreateWindow(window);
                result.Add(new Dictionary<string, object?>
                {
                    ["ref"] = entry.Ref,
                    ["name"] = ReadName(entry.Element),
                    ["processId"] = entry.ProcessId,
                    ["handle"] = entry.Handle.ToInt64(),
                    ["bounds"] = ReadBounds(entry.Element),
                    ["enabled"] = ReadEnabled(entry.Element)
                });
            }

            Write(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["windows"] = result
            });
            return false;
        }

        private bool Snapshot(JsonElement request)
        {
            RejectUnknownFields(request, "command", "windowRef", "processId", "name", "maxNodes");

            int selectors = CountSelectors(request);
            if (selectors != 1)
            {
                throw UiaException.Invalid("snapshot requires exactly one of 'windowRef', 'processId', or 'name'.");
            }

            int maxNodes = DefaultMaxNodes;
            if (TryGetProperty(request, "maxNodes", out JsonElement maxNodesValue))
            {
                if (maxNodesValue.ValueKind != JsonValueKind.Number ||
                    !maxNodesValue.TryGetInt32(out maxNodes) || maxNodes <= 0)
                {
                    throw UiaException.Invalid("'maxNodes' must be a positive 32-bit integer.");
                }
            }

            AutomationElement window = ResolveWindow(request);
            TreeWalker walker = TreeWalker.ControlViewWalker;
            var pending = new Stack<AutomationElement>(GetChildren(walker, window).AsEnumerable().Reverse());
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var result = new List<Dictionary<string, object?>>();

            while (pending.Count > 0 && result.Count < maxNodes)
            {
                AutomationElement element = pending.Pop();
                string? runtimeId = GetRuntimeId(element);
                if (runtimeId is null || !visited.Add(runtimeId))
                {
                    continue;
                }

                bool isPassword = ReadPassword(element);
                var patterns = ReadPatterns(element);
                result.Add(new Dictionary<string, object?>
                {
                    ["ref"] = GetOrCreateElementRef(element, window),
                    ["name"] = ReadName(element),
                    ["automationId"] = ReadAutomationId(element),
                    ["controlType"] = ReadControlType(element),
                    ["isPassword"] = isPassword,
                    ["isEnabled"] = ReadEnabled(element),
                    ["bounds"] = ReadBounds(element),
                    ["patterns"] = patterns
                    // No ValuePattern.Value is serialized for any element, including password controls.
                });

                IReadOnlyList<AutomationElement> children = GetChildren(walker, element);
                for (int i = children.Count - 1; i >= 0; i--)
                {
                    pending.Push(children[i]);
                }
            }

            bool truncated = pending.Count > 0;
            Write(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["elements"] = result,
                ["truncated"] = truncated
            });
            return false;
        }

        private bool Invoke(JsonElement request)
        {
            RejectUnknownFields(request, "command", "ref");
            AutomationElement element = ResolveActionElement(request);
            if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out object? patternObject) ||
                patternObject is not InvokePattern invokePattern)
            {
                throw new UiaException("pattern_not_supported", "The element does not support InvokePattern.");
            }

            invokePattern.Invoke();
            WriteSuccess();
            return false;
        }

        private bool SetValue(JsonElement request)
        {
            RejectUnknownFields(request, "command", "ref", "value");
            if (!TryGetString(request, "value", out string? value))
            {
                throw UiaException.Invalid("'value' must be a string.");
            }

            AutomationElement element = ResolveActionElement(request);
            if (ReadPassword(element))
            {
                throw new UiaException("password_protected", "Setting values on password controls is not allowed.");
            }

            if (!element.TryGetCurrentPattern(ValuePattern.Pattern, out object? patternObject) ||
                patternObject is not ValuePattern valuePattern)
            {
                throw new UiaException("pattern_not_supported", "The element does not support ValuePattern.");
            }

            valuePattern.SetValue(value!);
            WriteSuccess();
            return false;
        }

        private bool Key(JsonElement request)
        {
            RejectUnknownFields(request, "command", "keys", "processId");
            if (!TryGetString(request, "keys", out string? keys) || string.IsNullOrEmpty(keys))
            {
                throw UiaException.Invalid("'keys' must be a non-empty SendKeys string.");
            }
            if (!TryGetProperty(request, "processId", out JsonElement processIdValue) ||
                processIdValue.ValueKind != JsonValueKind.Number ||
                !processIdValue.TryGetInt32(out int expectedProcessId) || expectedProcessId <= 0)
            {
                throw UiaException.Invalid("'processId' must be a positive 32-bit integer.");
            }

            // This command deliberately has no element ref. Password-target approval belongs to the Node layer.
            Application.DoEvents();
            AutomationElement focused = AutomationElement.FocusedElement;
            if (ReadPassword(focused))
            {
                throw new UiaException("password_protected", "Sending keys to a password control is not allowed.");
            }
            IntPtr foreground = GetForegroundWindow();
            if (foreground == IntPtr.Zero || GetWindowThreadProcessId(foreground, out int foregroundProcessId) == 0 ||
                foregroundProcessId != expectedProcessId)
            {
                throw new UiaException("foreground_mismatch", "The target process is no longer in the foreground.");
            }
            SendKeys.SendWait(keys);
            Application.DoEvents();
            SendKeys.Flush();
            WriteSuccess();
            return false;
        }

        private bool Foreground(JsonElement request)
        {
            RejectUnknownFields(request, "command");
            IntPtr handle = GetForegroundWindow();
            if (handle == IntPtr.Zero || GetWindowThreadProcessId(handle, out int processId) == 0)
            {
                throw new UiaException("window_not_found", "There is no foreground window.");
            }

            string name;
            try
            {
                name = ReadName(AutomationElement.FromHandle(handle));
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                name = string.Empty;
            }

            bool focusedIsPassword = false;
            string focusedName = string.Empty;
            string focusedControlType = string.Empty;
            try
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                focusedIsPassword = ReadPassword(focused);
                focusedName = ReadName(focused);
                focusedControlType = ReadControlType(focused);
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                // Focus can change between calls; window-level foreground information remains valid.
            }

            Write(new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["processId"] = processId,
                ["handle"] = handle.ToInt64(),
                ["name"] = name,
                ["focusedIsPassword"] = focusedIsPassword,
                ["focusedName"] = focusedName,
                ["focusedControlType"] = focusedControlType
            });
            return false;
        }

        private bool Dispose(JsonElement request)
        {
            RejectUnknownFields(request, "command");
            Dispose();
            WriteSuccess();
            return true;
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }

            windows.Clear();
            windowRefs.Clear();
            elements.Clear();
            disposed = true;
        }

        private AutomationElement ResolveWindow(JsonElement request)
        {
            if (TryGetProperty(request, "windowRef", out JsonElement windowRefValue) &&
                windowRefValue.ValueKind != JsonValueKind.Null)
            {
                if (!TryGetString(request, "windowRef", out string? windowRef))
                {
                    throw UiaException.Invalid("'windowRef' must be a string.");
                }

                if (!windowRefs.TryGetValue(ParseRef(windowRef, 'w'), out WindowEntry? entry))
                {
                    throw UiaException.UnknownRef();
                }

                return ValidateWindow(entry);
            }

            IReadOnlyList<WindowCandidate> candidates = FindTopLevelWindows();
            WindowCandidate? selected = null;
            if (TryGetProperty(request, "processId", out JsonElement processIdValue) &&
                processIdValue.ValueKind != JsonValueKind.Null)
            {
                if (!TryGetInt32(request, "processId", out int processId) || processId <= 0)
                {
                    throw UiaException.Invalid("'processId' must be a positive 32-bit integer.");
                }

                selected = candidates.FirstOrDefault(candidate => candidate.ProcessId == processId);
            }
            else if (TryGetProperty(request, "name", out JsonElement nameValue) &&
                     nameValue.ValueKind != JsonValueKind.Null)
            {
                if (!TryGetString(request, "name", out string? name) || string.IsNullOrEmpty(name))
                {
                    throw UiaException.Invalid("'name' must be a non-empty string.");
                }

                selected = candidates.FirstOrDefault(candidate =>
                    string.Equals(ReadName(candidate.Element), name, StringComparison.Ordinal));
            }

            if (selected is null)
            {
                throw new UiaException("window_not_found", "No matching visible top-level window was found.");
            }

            return ValidateWindow(GetOrCreateWindow(selected.Value));
        }

        private static void AssertForegroundWindow(WindowEntry entry)
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground != entry.Handle || GetWindowThreadProcessId(foreground, out int processId) == 0 ||
            processId != entry.ProcessId)
        {
            throw new UiaException("foreground_mismatch", "The target window is no longer in the foreground.");
        }
    }

    private AutomationElement ResolveActionElement(JsonElement request)
        {
            if (!TryGetString(request, "ref", out string? reference))
            {
                throw UiaException.Invalid("'ref' is required.");
            }

            if (!elements.TryGetValue(ParseRef(reference, 'e'), out ElementEntry? entry))
            {
                throw UiaException.UnknownRef();
            }

            if (!windows.TryGetValue(entry.WindowKey, out WindowEntry? window))
            {
                throw new UiaException("window_not_found", "The window bound to this element no longer exists.");
            }

            AutomationElement expectedWindow = ValidateWindow(window);
            // Re-check immediately before the native action to close the Node/UIA time-of-check gap.
            AssertForegroundWindow(window);
            if (!ElementBelongsToWindow(entry.Element, expectedWindow))
            {
                throw new UiaException("element_stale", "The element no longer belongs to its bound window.");
            }

            return entry.Element;
        }

        private AutomationElement ValidateWindow(WindowEntry entry)
        {
            if (disposed || entry.Handle == IntPtr.Zero || !IsWindow(entry.Handle) ||
                GetWindowThreadProcessId(entry.Handle, out int processId) == 0 ||
                processId != entry.ProcessId)
            {
                throw new UiaException("window_not_found", "The bound window no longer exists.");
            }

            AutomationElement current;
            try
            {
                current = AutomationElement.FromHandle(entry.Handle);
                if (current.Current.ProcessId != entry.ProcessId ||
                    current.Current.NativeWindowHandle != entry.Handle ||
                    (entry.RuntimeId is not null && !string.Equals(GetRuntimeId(current), entry.RuntimeId, StringComparison.Ordinal)))
                {
                    throw new UiaException("window_not_found", "The bound window no longer exists.");
                }
            }
            catch (UiaException)
            {
                throw;
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                throw new UiaException("window_not_found", "The bound window is no longer available to UI Automation.");
            }

            return current;
        }

        private WindowEntry GetOrCreateWindow(WindowCandidate candidate)
        {
            WindowKey key = new(candidate.Handle, candidate.ProcessId);
            string? runtimeId = GetRuntimeId(candidate.Element);
            if (!windows.TryGetValue(key, out WindowEntry? entry) ||
                (entry.RuntimeId is not null && !string.Equals(entry.RuntimeId, runtimeId, StringComparison.Ordinal)))
            {
                nextWindowRef++;
                entry = new WindowEntry($"w{nextWindowRef}", key, candidate.Element, runtimeId);
                windows[key] = entry;
                windowRefs.Add(entry.Ref, entry);
            }

            return entry;
        }

        private string GetOrCreateElementRef(AutomationElement element, AutomationElement window)
        {
            WindowKey windowKey = new(window.Current.NativeWindowHandle, window.Current.ProcessId);
            nextElementRef++;
            string reference = $"e{nextElementRef}";
            // Never retarget an old ref if a provider recycles a runtime ID: each snapshot gets fresh refs.
            elements.Add(reference, new ElementEntry(windowKey, element));
            return reference;
        }

        private static IReadOnlyList<WindowCandidate> FindTopLevelWindows()
        {
            var handles = new List<IntPtr>();
            EnumWindows((handle, _) =>
            {
                if (IsWindowVisible(handle) && GetWindowThreadProcessId(handle, out int processId) != 0 && processId > 0)
                {
                    handles.Add(handle);
                }

                return true;
            }, IntPtr.Zero);

            var result = new List<WindowCandidate>();
            foreach (IntPtr handle in handles)
            {
                try
                {
                    AutomationElement element = AutomationElement.FromHandle(handle);
                    GetWindowThreadProcessId(handle, out int processId);
                    if (processId > 0 && element.Current.ControlType == ControlType.Window &&
                        element.Current.ProcessId == processId)
                    {
                        var bounds = ReadBounds(element);
                        if (bounds["x"] is double x && bounds["y"] is double y &&
                            x > -30000 && y > -30000 &&
                            bounds["width"] is double width && bounds["height"] is double height &&
                            width > 0 && height > 0)
                        {
                            result.Add(new WindowCandidate(element, handle, processId));
                        }
                    }
                }
                catch (Exception exception) when (IsUiaOrAutomationException(exception))
                {
                    // A window can close while the native collection is being enumerated.
                }
            }

            return result.OrderBy(candidate => candidate.Handle.ToInt64()).ToArray();
        }

        private static bool ElementBelongsToWindow(AutomationElement element, AutomationElement expectedWindow)
        {
            string? expectedRuntimeId = GetRuntimeId(expectedWindow);
            if (expectedRuntimeId is null)
            {
                return false;
            }

            TreeWalker walker = TreeWalker.ControlViewWalker;
            AutomationElement? current = element;
            var visited = new HashSet<string>(StringComparer.Ordinal);
            for (int depth = 0; current is not null && depth < MaximumOwnershipDepth; depth++)
            {
                string? runtimeId = GetRuntimeId(current);
                if (runtimeId is null)
                {
                    return false;
                }

                if (string.Equals(runtimeId, expectedRuntimeId, StringComparison.Ordinal))
                {
                    return true;
                }

                if (!visited.Add(runtimeId))
                {
                    return false;
                }

                current = walker.GetParent(current);
            }

            return false;
        }

        private static IReadOnlyList<AutomationElement> GetChildren(TreeWalker walker, AutomationElement parent)
        {
            var children = new List<AutomationElement>();
            AutomationElement? child = walker.GetFirstChild(parent);
            while (child is not null)
            {
                children.Add(child);
                child = walker.GetNextSibling(child);
            }

            return children;
        }

        private static string? GetRuntimeId(AutomationElement element)
        {
            try
            {
                int[] ids = element.GetRuntimeId();
                return ids.Length == 0 ? null : string.Join(",", ids);
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                return null;
            }
        }

        private static Dictionary<string, object?> ReadBounds(AutomationElement element)
        {
            try
            {
                // BoundingRectangle is a WindowsBase Rect. Reading it as an object avoids adding WPF references
                // solely for this four-number struct; WindowsDesktop.App already supplies it at runtime.
                object? rectangle = element.GetCurrentPropertyValue(AutomationElement.BoundingRectangleProperty);
                if (rectangle is null)
                {
                    return EmptyBounds();
                }

                Type rectangleType = rectangle.GetType();
                return new Dictionary<string, object?>
                {
                    ["x"] = ReadRectValue(rectangleType, rectangle, "X"),
                    ["y"] = ReadRectValue(rectangleType, rectangle, "Y"),
                    ["width"] = ReadRectValue(rectangleType, rectangle, "Width"),
                    ["height"] = ReadRectValue(rectangleType, rectangle, "Height")
                };
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                return EmptyBounds();
            }
        }

        private static double ReadRectValue(Type rectangleType, object rectangle, string propertyName)
        {
            return rectangleType.GetProperty(propertyName)?.GetValue(rectangle) is double value ? Finite(value) : 0;
        }

        private static Dictionary<string, object?> EmptyBounds() => new()
        {
            ["x"] = 0, ["y"] = 0, ["width"] = 0, ["height"] = 0
        };

        private static string ReadName(AutomationElement element) => ReadProperty(element, AutomationElement.NameProperty, string.Empty);
        private static string ReadAutomationId(AutomationElement element) => ReadProperty(element, AutomationElement.AutomationIdProperty, string.Empty);
        private static bool ReadEnabled(AutomationElement element) => ReadProperty(element, AutomationElement.IsEnabledProperty, false);
        private static bool ReadPassword(AutomationElement element)
    {
        try
        {
            return element.GetCurrentPropertyValue(AutomationElement.IsPasswordProperty) is bool value
                ? value
                : true;
        }
        catch (Exception exception) when (IsUiaOrAutomationException(exception))
        {
            return true;
        }
    }

        private static T ReadProperty<T>(AutomationElement element, AutomationProperty property, T fallback)
        {
            try
            {
                return element.GetCurrentPropertyValue(property) is T value ? value : fallback;
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                return fallback;
            }
        }

        private static string ReadControlType(AutomationElement element)
        {
            try
            {
                string? programmaticName = element.Current.ControlType?.ProgrammaticName;
                int separator = programmaticName?.LastIndexOf('.') ?? -1;
                return separator >= 0 ? programmaticName![(separator + 1)..] : programmaticName ?? "Unknown";
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                return "Unknown";
            }
        }

        private static string[] ReadPatterns(AutomationElement element)
        {
            try
            {
                return element.GetSupportedPatterns()
                    .Select(ReadPatternName)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(name => name, StringComparer.Ordinal)
                    .ToArray();
            }
            catch (Exception exception) when (IsUiaOrAutomationException(exception))
            {
                return [];
            }
        }

        private static string ReadPatternName(AutomationPattern pattern)
        {
            string[] parts = pattern.ProgrammaticName.Split('.');
            string identifier = parts[^1];
            if (string.Equals(identifier, "Pattern", StringComparison.Ordinal) && parts.Length > 1)
            {
                identifier = parts[^2];
            }

            const string identifiersSuffix = "PatternIdentifiers";
            if (identifier.EndsWith(identifiersSuffix, StringComparison.Ordinal))
            {
                return identifier[..^identifiersSuffix.Length];
            }

            const string patternSuffix = "Pattern";
            return identifier.EndsWith(patternSuffix, StringComparison.Ordinal)
                ? identifier[..^patternSuffix.Length]
                : identifier;
        }

        private static double Finite(double value) => double.IsFinite(value) ? value : 0;

        private static int CountSelectors(JsonElement request)
        {
            int count = 0;
            if (TryGetProperty(request, "windowRef", out JsonElement windowRef) && windowRef.ValueKind != JsonValueKind.Null)
            {
                count++;
            }

            if (TryGetProperty(request, "processId", out JsonElement processId) && processId.ValueKind != JsonValueKind.Null)
            {
                count++;
            }

            if (TryGetProperty(request, "name", out JsonElement name) && name.ValueKind != JsonValueKind.Null)
            {
                count++;
            }

            return count;
        }

        private static string ParseRef(string? value, char prefix)
        {
            if (string.IsNullOrEmpty(value) || value[0] != prefix || !int.TryParse(value.AsSpan(1), out int number) || number <= 0)
            {
                throw UiaException.UnknownRef();
            }

            return value;
        }

        private static bool TryGetProperty(JsonElement request, string name, out JsonElement value)
        {
            if (request.TryGetProperty(name, out value))
            {
                return true;
            }

            value = default;
            return false;
        }

        private static bool TryGetString(JsonElement request, string name, out string? value)
        {
            if (TryGetProperty(request, name, out JsonElement property) && property.ValueKind == JsonValueKind.String)
            {
                value = property.GetString();
                return true;
            }

            value = null;
            return false;
        }

        private static bool TryGetInt32(JsonElement request, string name, out int value)
        {
            if (TryGetProperty(request, name, out JsonElement property) &&
                property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value))
            {
                return true;
            }

            value = 0;
            return false;
        }

        private static void RejectUnknownFields(JsonElement request, params string[] allowed)
        {
            foreach (JsonProperty property in request.EnumerateObject())
            {
                if (!allowed.Contains(property.Name, StringComparer.Ordinal))
                {
                    throw UiaException.Invalid($"Unknown request field: {property.Name}");
                }
            }
        }

        private static bool Reject(string code, string message) => throw UiaException.Error(code, message);

        private static void WriteSuccess() => Write(new Dictionary<string, object?> { ["ok"] = true });

        private static void WriteError(string code, string message)
        {
            Write(new Dictionary<string, object?>
            {
                ["ok"] = false,
                ["error"] = new Dictionary<string, object?>
                {
                    ["code"] = code,
                    ["message"] = message
                }
            });
        }

        private static void Write(Dictionary<string, object?> response)
        {
            Console.Out.WriteLine(JsonSerializer.Serialize(response, JsonOptions));
            Console.Out.Flush();
        }

        private static string SafeMessage(Exception exception, string fallback)
        {
            string message = exception.Message.Trim();
            return message.Length == 0 ? fallback : message;
        }

        private static bool IsUiaOrAutomationException(Exception exception)
        {
            return exception is ElementNotAvailableException or InvalidOperationException or NotSupportedException or
                System.Runtime.InteropServices.COMException or System.ComponentModel.Win32Exception;
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int processId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        private readonly record struct WindowKey(IntPtr Handle, int ProcessId);

        private sealed record WindowEntry(string Ref, WindowKey Key, AutomationElement Element, string? RuntimeId)
        {
            public IntPtr Handle => Key.Handle;
            public int ProcessId => Key.ProcessId;
        }

        private sealed record ElementEntry(WindowKey WindowKey, AutomationElement Element);

        private readonly record struct WindowCandidate(AutomationElement Element, IntPtr Handle, int ProcessId);

        private sealed class UiaException(string code, string message) : Exception(message)
        {
            public string Code { get; } = code;

            public static UiaException Error(string code, string message) => new(code, message);
            public static UiaException Invalid(string message) => new("invalid_request", message);
            public static UiaException UnknownRef() => new("unknown_ref", "The reference is unknown or has an invalid format.");
        }
    }
}
