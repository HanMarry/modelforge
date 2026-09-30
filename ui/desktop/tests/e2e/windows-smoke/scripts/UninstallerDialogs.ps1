# Window helpers for Uninstall-ModelForge.ps1 (spec mathmodel-parity-and-beyond, task 13.6):
# find the uninstaller's windows, tell them apart by their controls and press their buttons.
# Dot-source it after SmokeCommon.ps1. Windows PowerShell 5.1, ASCII only (see SmokeCommon.ps1).
#
# What UI Automation offers here. Windows PowerShell uses the managed client
# (System.Windows.Automation), and it shows the Win32 controls of a MessageBox as bare panes:
# ControlType Pane, no InvokePattern, the message text a pane as well (seen locally on Windows 11
# 24H2; run 36686960299 found the "ModelForge Uninstall" box but never pressed anything, which
# fits). What it does give reliably for each control is the window handle, the Win32 class
# ("#32770", "Button", "Static"), the control id (AutomationId), the window text (Name) and
# IsEnabled. So:
#
#   - a window is recognised by its controls, never by its text, so the installer language does
#     not matter: a MessageBox is a #32770 holding only buttons, its icon (id 20) and its text
#     (id 65535); the NSIS wizard is a #32770 whose current page is a child #32770;
#   - a button is the "Button" child with the control id: IDOK 1, IDCANCEL 2, IDYES 6, IDNO 7 in
#     a MessageBox; 1 = Next / Uninstall / Finish, 2 = Cancel, 3 = Back in the NSIS wizard;
#   - a press is the WM_COMMAND / BN_CLICKED message a click sends to the button's dialog, posted
#     (PostMessage does not wait, so a button that opens the next dialog cannot block this
#     script). The NSIS wizard ignores it while the button is disabled, like a click.
#
# user32 is reached through a P/Invoke type built with System.Reflection.Emit. Add-Type would
# compile C# through csc.exe and temporary files under %TEMP%, which in the cn-user scenario is
# a profile path with Chinese characters and a space; the dynamic type needs neither.

$script:WM_COMMAND = 0x0111
$script:ID_OK = 1
$script:ID_YES = 6
$script:ID_NO = 7

function Get-User32 {
    if ($script:MfUser32) { return $script:MfUser32 }
    $name = New-Object System.Reflection.AssemblyName('MfSmokeUser32')
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('MfSmokeUser32')
    $builder = $module.DefineType('MfSmokeUser32.Native', [System.Reflection.TypeAttributes]'Public, Class, Abstract, Sealed')
    $attributes = [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl, HideBySig'
    # BOOL PostMessageW(HWND, UINT, WPARAM, LPARAM)
    $method = $builder.DefinePInvokeMethod('PostMessageW', 'user32.dll', $attributes,
        [System.Reflection.CallingConventions]::Standard, [bool], [Type[]]@([IntPtr], [UInt32], [IntPtr], [IntPtr]),
        [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
    $script:MfUser32 = $builder.CreateType()
    return $script:MfUser32
}

# Loads UI Automation and user32; returns the desktop (root) element. Throws when UI Automation
# is missing; a user32 failure only leaves InvokePattern as the way to press buttons.
function Initialize-UninstallerUi {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:User32Error = ''
    try {
        $null = Get-User32
    }
    catch {
        $script:User32Error = $_.Exception.Message
        Write-Host ("user32 unavailable, falling back to InvokePattern: {0}" -f $script:User32Error)
    }
    return [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-ChildrenByClass($element, [string] $className, [switch] $Deep) {
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, $className)
    $scope = [System.Windows.Automation.TreeScope]::Children
    if ($Deep) { $scope = [System.Windows.Automation.TreeScope]::Descendants }
    return @($element.FindAll($scope, $condition))
}

# UI Automation exposes the customUnInstall Yes/No MessageBox as an owned #32770 dialog while
# the NSIS wizard remains disabled behind it.  The message box is not necessarily a direct child
# of the desktop root, so collect direct and descendant dialogs, de-duplicated by HWND.  The
# caller still applies Test-UninstallerWindow before any dialog is inspected or pressed; this is
# a bounded class query, not a walk that follows arbitrary desktop controls.
function Get-DialogWindows($root) {
    $seen = @{}
    $topLevel = @{}
    $windows = @()
    foreach ($window in (Get-ChildrenByClass $root '#32770')) {
        try {
            $hwnd = [int]$window.Current.NativeWindowHandle
            if ($hwnd -eq 0 -or $seen.ContainsKey($hwnd)) { continue }
            $seen[$hwnd] = $true
            $topLevel[$hwnd] = $true
            $windows += $window
        }
        catch {
            # A dialog can disappear between FindAll and Current; the next poll will retry.
        }
    }
    foreach ($window in (Get-ChildrenByClass $root '#32770' -Deep)) {
        try {
            $hwnd = [int]$window.Current.NativeWindowHandle
            if ($hwnd -eq 0 -or $seen.ContainsKey($hwnd)) { continue }
            $seen[$hwnd] = $true
            $windows += $window
        }
        catch {
            # A dialog can disappear between FindAll and Current; the next poll will retry.
        }
    }
    $script:TopLevelDialogHwnds = $topLevel
    return @($windows)
}

function Get-Clipped([string] $text, [int] $max = 300) {
    $flat = ($text -replace '\s+', ' ').Trim()
    if ($flat.Length -le $max) { return $flat }
    return $flat.Substring(0, $max) + '...'
}

# Non-empty texts of the Static controls under $element (the message of a MessageBox, the
# headings and descriptions of a wizard page), joined with newlines.
function Get-StaticText($element, [switch] $Deep) {
    $parts = @()
    foreach ($static in (Get-ChildrenByClass $element 'Static' -Deep:$Deep)) {
        $name = [string]$static.Current.Name
        if ($name.Trim()) { $parts += $name }
    }
    return ($parts -join "`n")
}

# One top-level #32770 window: title, owning process, role, buttons and text. The UI Automation
# element is kept under "element" for pressing; Get-DialogSummary drops it for the JSON result.
function Get-DialogInfo($window) {
    $current = $window.Current
    $info = [ordered]@{
        element = $window
        hwnd    = [int]$current.NativeWindowHandle
        title   = [string]$current.Name
        pid     = [int]$current.ProcessId
        process = ''
        role    = ''
        page    = 0
        buttons = @()
        text    = ''
    }
    try { $info.process = (Get-Process -Id $info.pid -ErrorAction Stop).ProcessName } catch { $info.process = '?' }
    $pages = @()
    $ids = @()
    $texts = @()
    $children = $window.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($child in $children) {
        $c = $child.Current
        $class = [string]$c.ClassName
        if ($class -eq '#32770') {
            $pages += $child
            continue
        }
        $id = 0
        if (-not [int]::TryParse([string]$c.AutomationId, [ref] $id)) { continue }
        $ids += $id
        if ($class -eq 'Button') {
            $info.buttons += [pscustomobject]@{
                id      = $id
                label   = ([string]$c.Name) -replace '&', ''
                enabled = [bool]$c.IsEnabled
                hwnd    = [int]$c.NativeWindowHandle
                element = $child
            }
        }
        elseif ($class -eq 'Static' -and ([string]$c.Name).Trim()) {
            $texts += [string]$c.Name
        }
    }
    $buttonIds = @($info.buttons | ForEach-Object { $_.id })
    # A MessageBox holds its buttons (ids 1-11), the icon (20) and the text (65535), nothing else.
    $foreign = @($ids | Where-Object { -not (($_ -ge 1 -and $_ -le 11) -or $_ -eq 20 -or $_ -eq 65535) })
    $isMessageBox = ($ids -contains 65535) -and ($foreign.Count -eq 0)
    if ($pages.Count -gt 0) {
        # NSIS wizard: the page is a child dialog, replaced on every page change.
        $info.role = 'wizard'
        $info.page = [int]$pages[0].Current.NativeWindowHandle
        $info.text = Get-StaticText $pages[0] -Deep
    }
    else {
        $info.text = ($texts -join "`n")
        if (-not $isMessageBox) {
            # Neither a MessageBox nor a wizard page: typically the wizard between two pages.
            $info.role = 'other'
        }
        elseif ($buttonIds -contains $script:ID_YES -and $buttonIds -contains $script:ID_NO) {
            # MB_YESNO: the keep-data question of customUnInstall (build/installer.nsh).
            $info.role = 'keep-data-question'
        }
        elseif ($buttonIds.Count -eq 2 -and $buttonIds -contains $script:ID_OK -and $buttonIds -contains 2) {
            # MB_OKCANCEL: electron-builder's "Are you sure you want to uninstall" (one-click
            # uninstaller), or its "the app is running, OK closes it" box.
            $info.role = 'confirm'
        }
        else {
            $info.role = 'unexpected'
        }
    }
    return $info
}

function Format-Buttons($info) {
    $parts = @()
    foreach ($button in $info.buttons) {
        $state = ''
        if (-not $button.enabled) { $state = ' disabled' }
        $parts += ("{0} '{1}'{2}" -f $button.id, $button.label, $state)
    }
    return ($parts -join ', ')
}

# The window as the result JSON and the error messages show it.
function Get-DialogSummary($info) {
    return [ordered]@{
        role    = $info.role
        hwnd    = $info.hwnd
        title   = $info.title
        process = $info.process
        pid     = $info.pid
        buttons = (Format-Buttons $info)
        text    = (Get-Clipped $info.text 400)
    }
}

function Format-Dialog($info) {
    return ("{0} '{1}' ({2} pid {3}), buttons [{4}], text '{5}'" -f $info.role, $info.title, $info.process,
        $info.pid, (Format-Buttons $info), (Get-Clipped $info.text 200))
}

# Presses $button of the dialog $info. Returns how ('WM_COMMAND' or 'InvokePattern'), or '' when
# neither worked.
function Invoke-DialogButton($info, $button) {
    if ($script:MfUser32) {
        # WM_COMMAND: wParam = MAKEWPARAM(id, BN_CLICKED = 0), lParam = the button's handle.
        $posted = $script:MfUser32::PostMessageW([IntPtr]$info.hwnd, [UInt32]$script:WM_COMMAND,
            [IntPtr]$button.id, [IntPtr]$button.hwnd)
        if ($posted) { return 'WM_COMMAND' }
    }
    $pattern = $null
    if ($button.element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref] $pattern)) {
        $pattern.Invoke()
        return 'InvokePattern'
    }
    return ''
}

function Get-ButtonById($info, [int] $id) {
    foreach ($button in $info.buttons) {
        if ($button.id -eq $id) { return $button }
    }
    return $null
}

<#
    Drives the uninstaller's windows until it is done, one window per round, message boxes before
    the wizard behind them (it is disabled while one is open):

      confirm             OK/Cancel box (one-click uninstaller asks "are you sure")  -> 1 (OK)
      wizard              NSIS wizard page (assisted uninstaller)  -> 1 (Next / Uninstall /
                          Finish) when enabled; while it is disabled (uninstalling) wait
      keep-data-question  Yes/No box of customUnInstall  -> 6 (Yes: keep) for -Mode Keep,
                          7 (No: remove) for -Mode Remove, as build/installer.nsh maps them
      unexpected          any other MessageBox (an error, "retry / cancel")
      other               a dialog that is neither a MessageBox nor a wizard page (the wizard
                          between two pages, for a moment)
                          -> nothing is pressed; still there after -UnexpectedSeconds: stop and
                          report it

    Each press is logged and recorded. A window that is still there 5 s after a press is pressed
    again, at most 3 times in all. The page, the button label and the window handle identify
    "the same" window, so a wizard's next page is a new window.

    -IsOurWindow { param($info) ... } picks the uninstaller's windows among the top-level dialogs;
    -IsFinished { ... } says whether the uninstall is complete (checked while no window is open);
    -OnScreenshot { param($name) ... } takes a screenshot.

    Returns the state: outcome finished | timeout | no-window | unexpected-dialog | no-reaction |
    cannot-click, flow one-click | assisted | '', what was asked and answered, the pressed
    buttons (clicks: one line each; steps: details), the windows open at the end (openWindows)
    and UI Automation errors.
#>
function Invoke-UninstallerDialogs {
    param(
        [Parameter(Mandatory = $true)] $Root,
        [Parameter(Mandatory = $true)][ValidateSet('Keep', 'Remove')][string] $Mode,
        [Parameter(Mandatory = $true)][scriptblock] $IsOurWindow,
        [Parameter(Mandatory = $true)][scriptblock] $IsFinished,
        [scriptblock] $OnScreenshot = $null,
        [int] $TimeoutSeconds = 300,
        [int] $NoWindowSeconds = 60,
        [int] $RepressSeconds = 5,
        [int] $MaxPresses = 3,
        [int] $UnexpectedSeconds = 5
    )
    $state = [ordered]@{
        outcome      = ''
        flow         = ''
        confirmSeen  = $false
        confirmText  = ''
        promptSeen   = $false
        promptText   = ''
        answered     = ''
        dialogs      = @()
        clicks       = @()
        steps        = @()
        openWindows  = @()
        uiaErrors    = @()
        message      = ''
    }
    $shoot = {
        param($name)
        if ($OnScreenshot) { & $OnScreenshot $name }
    }
    # Which window of a round is handled: a box before the wizard it belongs to (the wizard is
    # disabled while the box is open), anything unknown last.
    $rank = @{ 'keep-data-question' = 0; 'confirm' = 1; 'unexpected' = 2; 'wizard' = 3; 'other' = 4 }
    $presses = @{}
    $lastPress = @{}
    $firstSeen = @{}
    $sawWindow = $false
    $sawWizard = $false
    $started = Get-Date

    :poll while ($true) {
        $elapsed = ((Get-Date) - $started).TotalSeconds
        $infos = @()
        try {
            foreach ($window in (Get-DialogWindows $Root)) {
                try {
                    $info = Get-DialogInfo $window
                    if (& $IsOurWindow $info) {
                        # Descendant #32770 controls include the NSIS page itself. Keep nested
                        # MessageBoxes (the Yes/No prompt or a real error), but do not let a page
                        # shadow the target wizard in the polling/ranking logic.
                        $topLevel = $script:TopLevelDialogHwnds.ContainsKey([int]$info.hwnd)
                        if ($topLevel -or $info.role -notin @('wizard', 'other')) {
                            $infos += $info
                        }
                    }
                }
                catch {
                    # Typically the window closed while it was being read.
                    if ($state.uiaErrors.Count -lt 20) { $state.uiaErrors += $_.Exception.Message }
                }
            }
        }
        catch {
            if ($state.uiaErrors.Count -lt 20) { $state.uiaErrors += $_.Exception.Message }
        }
        $state.openWindows = @($infos | ForEach-Object { Get-DialogSummary $_ })

        if ($infos.Count -eq 0 -and (& $IsFinished)) {
            $state.outcome = 'finished'
            break poll
        }
        if ($elapsed -gt $TimeoutSeconds) {
            $state.outcome = 'timeout'
            break poll
        }
        if ($infos.Count -eq 0) {
            if (-not $sawWindow -and $elapsed -gt $NoWindowSeconds) {
                $state.outcome = 'no-window'
                break poll
            }
            Start-Sleep -Milliseconds 500
            continue poll
        }

        if (-not $sawWindow) {
            $sawWindow = $true
            & $shoot 'first-dialog'
        }
        $info = @($infos | Sort-Object -Property @{ Expression = { $rank[$_.role] } })[0]
        $seen = ("{0}: {1}" -f $info.role, $info.title)
        if ($state.dialogs -notcontains $seen) { $state.dialogs += $seen }
        if (-not $firstSeen.ContainsKey($info.hwnd)) { $firstSeen[$info.hwnd] = Get-Date }

        $target = $null
        $answer = ''
        if ($info.role -eq 'unexpected' -or $info.role -eq 'other') {
            # Nothing to press. A wizard between two pages looks like this for a moment; a box
            # (an error, "retry / cancel") stays until someone answers it.
            if (((Get-Date) - $firstSeen[$info.hwnd]).TotalSeconds -ge $UnexpectedSeconds) {
                & $shoot 'unexpected'
                $state.outcome = 'unexpected-dialog'
                $state.message = ('unexpected uninstaller dialog for {0} s: {1}' -f $UnexpectedSeconds, (Format-Dialog $info))
                break poll
            }
        }
        elseif ($info.role -eq 'confirm') {
            $state.confirmSeen = $true
            $state.confirmText = Get-Clipped $info.text 400
            $target = Get-ButtonById $info $script:ID_OK
        }
        elseif ($info.role -eq 'keep-data-question') {
            if (-not $state.promptSeen) { & $shoot 'prompt' }
            $state.promptSeen = $true
            $state.promptText = $info.text
            if ($Mode -eq 'Keep') {
                $target = Get-ButtonById $info $script:ID_YES; $answer = 'yes'
            }
            else {
                $target = Get-ButtonById $info $script:ID_NO; $answer = 'no'
            }
        }
        elseif ($info.role -eq 'wizard') {
            if (-not $sawWizard) { & $shoot 'wizard' }
            $sawWizard = $true
            $next = Get-ButtonById $info $script:ID_OK
            if ($next -and $next.enabled) { $target = $next }
        }

        if ($target -and $target.enabled) {
            $key = '{0}|{1}|{2}|{3}' -f $info.hwnd, $info.page, $target.id, $target.label
            $count = 0
            if ($presses.ContainsKey($key)) { $count = $presses[$key] }
            $due = ($count -eq 0) -or (((Get-Date) - $lastPress[$key]).TotalSeconds -ge $RepressSeconds)
            if ($due) {
                if ($count -ge $MaxPresses) {
                    & $shoot 'no-reaction'
                    $state.outcome = 'no-reaction'
                    $state.message = ('the uninstaller did not react to {0} presses of button {1} in {2}' -f $count, $target.id, (Format-Dialog $info))
                    break poll
                }
                $method = Invoke-DialogButton $info $target
                if (-not $method) {
                    $state.outcome = 'cannot-click'
                    $state.message = ('cannot press button {0} (no user32, no InvokePattern) in {1}' -f $target.id, (Format-Dialog $info))
                    break poll
                }
                $presses[$key] = $count + 1
                $lastPress[$key] = Get-Date
                if ($answer) { $state.answered = $answer }
                $step = Get-DialogSummary $info
                $step.at = [math]::Round($elapsed, 1)
                $step.pressed = $target.id
                $step.label = $target.label
                $step.method = $method
                $step.attempt = $count + 1
                $state.steps += $step
                $line = "{0} '{1}': {2} {3}" -f $info.role, $info.title, $target.id, $target.label
                if ($count -gt 0) { $line += (' (again, press {0})' -f ($count + 1)) }
                $state.clicks += $line
                Write-Host ("[uninstall {0,6:0.0}s] {1} -> pressed {2} '{3}' ({4})" -f $elapsed, (Format-Dialog $info), $target.id, $target.label, $method)
            }
        }
        Start-Sleep -Milliseconds 500
    }

    if ($sawWizard) { $state.flow = 'assisted' }
    elseif ($state.confirmSeen) { $state.flow = 'one-click' }
    if (-not $state.message -and $state.outcome -eq 'timeout') {
        if ($state.openWindows.Count -gt 0) {
            $open = @($state.openWindows | ForEach-Object {
                    "{0} '{1}' ({2} pid {3}), buttons [{4}], text '{5}'" -f $_.role, $_.title, $_.process, $_.pid, $_.buttons, (Get-Clipped $_.text 200)
                })
            $state.message = ('waiting at {0}' -f ($open -join '; '))
        }
        else {
            $state.message = 'no uninstaller window is open'
        }
    }
    return $state
}
