<#
.SYNOPSIS
    Picks a folder in the Windows folder dialog that ModelForge opened, as a user would (13.6).

.DESCRIPTION
    "Choose location" in the onboarding wizard calls dialog.showOpenDialog with
    properties ['openDirectory', 'createDirectory'] in the main process (main.ts,
    'directory-chooser'), which shows the Windows folder picker without an owner window. CDP
    cannot reach native dialogs, so this script does the user's part: it waits for that dialog (a
    #32770 window of the ModelForge main process -ProcessId), types -Folder into its folder name
    box and presses its OK button ("Select Folder", control id 1). When the dialog only opens the
    typed folder instead of returning it (the box is then empty or holds the folder's own name),
    OK is pressed again, at most three times in all.

    Text goes in through UI Automation's ValuePattern, or WM_SETTEXT where that is missing; OK is
    pressed with the WM_COMMAND message a click sends (see UninstallerDialogs.ps1 for why).
    The folder must exist ('createDirectory' has no effect on Windows).

    The result has the dialog's title and buttons, how the text went in, the presses, the edit
    boxes seen (for a dialog that looks different) and, on failure, a screenshot. A dialog left
    open by a failure is cancelled (control id 2), so the app is not stuck behind it.

    Exit codes: 0 the dialog closed after OK with the folder typed in; 1 it did not (no folder
    box, a message box from the dialog, still open after three presses); 3 no dialog of that
    process within -TimeoutSeconds, or UI Automation is unavailable.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int] $ProcessId,
    [Parameter(Mandatory = $true)][string] $Folder,
    [string] $EvidenceDir = '',
    [string] $ResultFile = '',
    [int] $TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SmokeCommon.ps1')
. (Join-Path $PSScriptRoot 'UninstallerDialogs.ps1')

$EXIT_NO_DIALOG = 3
$WM_SETTEXT = 0x000C
$ID_CANCEL = 2

$result = [ordered]@{
    ok          = $false
    # picked | no-dialog | no-folder-box | message-box | still-open | uia-unavailable | error
    outcome     = ''
    processId   = $ProcessId
    folder      = $Folder
    dialog      = $null
    textMethod  = ''
    textAfter   = ''
    presses     = 0
    editBoxes   = @()
    messageText = ''
    cancelled   = $false
    screenshots = @()
    error       = $null
}
$exitCode = 1

function Add-Screenshot([string] $name) {
    if (-not $EvidenceDir) { return }
    New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
    $file = Join-Path $EvidenceDir ("folder-dialog-{0}.png" -f $name)
    if (Save-Screenshot -Path $file) { $script:result.screenshots += $file }
}

# SendMessageW with a string lParam, for WM_SETTEXT (built like Get-User32 in UninstallerDialogs.ps1).
function Get-TextUser32 {
    if ($script:MfTextUser32) { return $script:MfTextUser32 }
    $name = New-Object System.Reflection.AssemblyName('MfSmokeTextUser32')
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('MfSmokeTextUser32')
    $builder = $module.DefineType('MfSmokeTextUser32.Native', [System.Reflection.TypeAttributes]'Public, Class, Abstract, Sealed')
    $attributes = [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl, HideBySig'
    $method = $builder.DefinePInvokeMethod('SendMessageW', 'user32.dll', $attributes,
        [System.Reflection.CallingConventions]::Standard, [IntPtr], [Type[]]@([IntPtr], [UInt32], [IntPtr], [string]),
        [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
    $script:MfTextUser32 = $builder.CreateType()
    return $script:MfTextUser32
}

# Top-level #32770 windows of the ModelForge main process.
function Get-ProcessDialogs($root) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '#32770')))
    return @($root.FindAll([System.Windows.Automation.TreeScope]::Children, $condition))
}

function Test-WindowOpen([int] $hwnd) {
    try {
        $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
        return ($null -ne $element) -and ([int]$element.Current.NativeWindowHandle -eq $hwnd)
    }
    catch {
        return $false
    }
}

# The folder name box. The folder picker ("Select Folder", seen in run 36850049924) has a plain
# Edit with control id 1152 (edt1) next to its "Folder:" label, directly under the dialog; the file
# dialogs use the Edit of the combo box 1148 (cmb13). Failing both, the only visible Edit. All
# Edits are recorded.
function Find-FolderBox($dialog) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $boxes = @()
    foreach ($edit in (Get-ChildrenByClass $dialog 'Edit' -Deep)) {
        try {
            $c = $edit.Current
            $parent = $walker.GetParent($edit)
            $boxes += [pscustomobject]@{
                element     = $edit
                id          = [string]$c.AutomationId
                name        = [string]$c.Name
                hwnd        = [int]$c.NativeWindowHandle
                offscreen   = [bool]$c.IsOffscreen
                parentId    = $(if ($parent) { [string]$parent.Current.AutomationId } else { '' })
                parentClass = $(if ($parent) { [string]$parent.Current.ClassName } else { '' })
            }
        }
        catch {
            # Gone while being read.
        }
    }
    $script:result.editBoxes = @($boxes | ForEach-Object {
            '{0} parent {1}/{2} hwnd {3}{4}' -f $_.id, $_.parentClass, $_.parentId, $_.hwnd, $(if ($_.offscreen) { ' offscreen' } else { '' })
        })
    $pick = @($boxes | Where-Object { $_.id -eq '1152' } | Select-Object -First 1)
    if ($pick.Count -eq 0) {
        $pick = @($boxes | Where-Object { $_.id -eq '1148' -or $_.parentId -eq '1148' } | Select-Object -First 1)
    }
    if ($pick.Count -eq 0) {
        $visible = @($boxes | Where-Object { -not $_.offscreen })
        if ($visible.Count -eq 1) { $pick = $visible }
    }
    if ($pick.Count -eq 0) { return $null }
    return $pick[0]
}

function Get-BoxText($box) {
    $pattern = $null
    try {
        if ($box.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $pattern)) {
            return [string]$pattern.Current.Value
        }
        return [string]$box.element.Current.Name
    }
    catch {
        return ''
    }
}

function Set-BoxText($box, [string] $text) {
    $pattern = $null
    try {
        if ($box.element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref] $pattern)) {
            $pattern.SetValue($text)
            if ((Get-BoxText $box) -eq $text) { return 'ValuePattern' }
        }
    }
    catch {
        Write-Host ("ValuePattern.SetValue failed: {0}" -f $_.Exception.Message)
    }
    if ($box.hwnd -ne 0) {
        $null = (Get-TextUser32)::SendMessageW([IntPtr]$box.hwnd, [UInt32]$WM_SETTEXT, [IntPtr]::Zero, $text)
        return 'WM_SETTEXT'
    }
    return ''
}

$dialogInfo = $null
try {
    try {
        $root = Initialize-UninstallerUi
    }
    catch {
        $result.outcome = 'uia-unavailable'
        $exitCode = $EXIT_NO_DIALOG
        throw ("UI Automation unavailable: {0}" -f $_.Exception.Message)
    }

    # 1. The dialog.
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $dialog = $null
    while ((Get-Date) -lt $deadline -and -not $dialog) {
        foreach ($window in (Get-ProcessDialogs $root)) {
            try {
                $info = Get-DialogInfo $window
                # The folder picker has its OK and Cancel buttons; a message box is told apart by
                # Get-DialogInfo and handled below.
                if ((Get-ButtonById $info 1) -and (Get-ButtonById $info $ID_CANCEL) -and $info.role -ne 'keep-data-question') {
                    $dialog = $window
                    $dialogInfo = $info
                    break
                }
            }
            catch {
                # Closed while being read; poll again.
            }
        }
        if (-not $dialog) { Start-Sleep -Milliseconds 250 }
    }
    if (-not $dialog) {
        $result.outcome = 'no-dialog'
        $exitCode = $EXIT_NO_DIALOG
        Add-Screenshot 'no-dialog'
        throw ("no dialog of process {0} appeared within {1} s" -f $ProcessId, $TimeoutSeconds)
    }
    $result.dialog = Get-DialogSummary $dialogInfo
    Write-Host ("folder dialog: {0}" -f (Format-Dialog $dialogInfo))

    # 2. The folder name box, with the folder typed in.
    $box = Find-FolderBox $dialog
    if (-not $box) {
        $result.outcome = 'no-folder-box'
        Add-Screenshot 'no-folder-box'
        throw ("the dialog has no folder name box; edit boxes: {0}" -f ($result.editBoxes -join '; '))
    }
    $result.textMethod = Set-BoxText $box $Folder
    $result.textAfter = Get-BoxText $box
    if (-not $result.textMethod) { throw 'cannot type into the folder name box' }

    # 3. OK, again while the dialog only opened the folder.
    $ok = Get-ButtonById $dialogInfo 1
    while ($result.presses -lt 3) {
        $method = Invoke-DialogButton $dialogInfo $ok
        if (-not $method) { throw 'cannot press the OK button (no user32, no InvokePattern)' }
        $result.presses++
        Write-Host ("pressed {0} '{1}' ({2}), press {3}" -f $ok.id, $ok.label, $method, $result.presses)
        $closeBy = (Get-Date).AddSeconds(5)
        while ((Get-Date) -lt $closeBy -and (Test-WindowOpen $dialogInfo.hwnd)) { Start-Sleep -Milliseconds 200 }
        if (-not (Test-WindowOpen $dialogInfo.hwnd)) {
            $result.outcome = 'picked'
            $exitCode = 0
            break
        }
        # A message box of the dialog (for example "path does not exist") stops here.
        foreach ($window in (Get-ProcessDialogs $root)) {
            try {
                $other = Get-DialogInfo $window
                if ($other.hwnd -ne $dialogInfo.hwnd -and $other.role -ne 'wizard' -and $other.role -ne 'other') {
                    $result.messageText = Get-Clipped $other.text 400
                    $result.outcome = 'message-box'
                    Add-Screenshot 'message-box'
                    $close = Get-ButtonById $other 1
                    if (-not $close) { $close = Get-ButtonById $other $ID_CANCEL }
                    if ($close) { $null = Invoke-DialogButton $other $close; Start-Sleep -Milliseconds 500 }
                    throw ("the dialog answered with a message box: {0}" -f $result.messageText)
                }
            }
            catch {
                if ($result.outcome -eq 'message-box') { throw }
            }
        }
        # Still open: it opened the typed folder; the box now shows its name or nothing.
        $now = Get-BoxText $box
        Write-Host ("dialog still open; folder name box now '{0}'" -f $now)
        $leaf = Split-Path -Leaf $Folder
        if ($now -and $now -ne $leaf -and $now -ne $Folder) {
            Set-BoxText $box $Folder | Out-Null
        }
    }
    if ($result.outcome -ne 'picked') {
        $result.outcome = 'still-open'
        Add-Screenshot 'still-open'
        throw ("the dialog was still open after {0} presses of OK" -f $result.presses)
    }
}
catch {
    if (-not $result.outcome) { $result.outcome = 'error' }
    $result.error = $_.Exception.Message
    Write-Host ("folder dialog failed ({0}): {1}" -f $result.outcome, $result.error)
}

# Leave nothing open behind a failure.
if ($exitCode -ne 0 -and $dialogInfo -and (Test-WindowOpen $dialogInfo.hwnd)) {
    $cancel = Get-ButtonById $dialogInfo $ID_CANCEL
    if ($cancel -and (Invoke-DialogButton $dialogInfo $cancel)) {
        $result.cancelled = $true
        Start-Sleep -Milliseconds 500
    }
}

$result.ok = ($exitCode -eq 0)
Write-SmokeResult -Result $result -Path $ResultFile
exit $exitCode
