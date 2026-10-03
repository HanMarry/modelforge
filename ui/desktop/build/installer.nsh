; ModelForge NSIS customisation (spec mathmodel-parity-and-beyond, requirement 7.10).
;
; The uninstaller asks whether to keep the user's configuration and chat sessions.
; Project folders are chosen by the user and live outside the app's data directories,
; so they are never touched here — the prompt says so explicitly.
;
; Answering "yes" (the default) leaves everything in place, which is also what an
; upgrade does, so reinstalling keeps providers, keys and history (requirement 7.5).
;
; Answering "no" removes the directories ModelForge and its kernel use on Windows:
;
;   %APPDATA%\ModelForge
;       Electron userData (productName "ModelForge"): settings.json with the onboarding
;       record, agent-kernel-secrets.json (the desktop credential store), recent-dirs.json,
;       logs, checkpoints (auto-snapshot repositories kept apart from the Project folders),
;       learning progress, Feishu settings, agent runtimes and the Chromium caches.
;   %LOCALAPPDATA%\modelforge-updater
;       electron-updater download cache (updaterCacheDirName in forge.config.ts).
;   %APPDATA%\Block\goose
;       goose.exe's own directories. goose resolves them with etcetera's Windows strategy
;       (author "Block", app "goose"; crates/goose/src/config/paths.rs): config\ holds
;       config.yaml (providers, models, extensions), custom_providers\, secrets.yaml when the
;       OS keyring is unavailable, skills, memory and OAuth tokens; data\ holds
;       sessions\sessions.db, logs, the provider inventory and the extracted built-in skills.
;       An upstream goose installed on the same machine shares this directory.
;   %LOCALAPPDATA%\Block\goose
;       goose's cache (cache\computer_controller, cache\autovisualiser).
;
; The "Block" parents are removed only when they are left empty, so other Block apps keep
; their data. ~/.config/goose and ~/.local/share/goose are goose's Linux locations and are
; not used on Windows. A GOOSE_PATH_ROOT override is a developer setting and is not followed.
; Keys goose stored in Windows Credential Manager are not removed here.
;
; The two welcome-page hooks below replace electron-builder's setInstallModePerUser with a copy
; that does not read past the end of the Shell's per-user Programs path (see
; build/modelforge-multiuser.nsh: a fresh install crashed in System.dll with 0xC0000005).
; electron-builder inserts them after multiUser.nsh and before the install-mode page functions,
; .onInit and un.onInit are compiled, which is the only place the macro can be swapped. The
; installer has no welcome page of its own, so customWelcomePage adds none; the uninstaller
; keeps its default welcome page.

!macro customWelcomePage
  !include "modelforge-multiuser.nsh"
!macroend

!macro customUnWelcomePage
  !include "modelforge-multiuser.nsh"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUnInstall
  ; A silent uninstall (upgrade, CI, or /S) must not block on a dialog: keep the data.
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否保留 ModelForge 的配置、模型密钥与会话记录？$\n$\n选择「是」将保留这些数据，下次安装可继续使用。$\n选择「否」将删除它们，包括内核目录 %APPDATA%\Block\goose（本机另装的 goose 也使用这个目录）。$\n$\n你的项目文件夹不在此范围内，始终不会被删除。" \
        /SD IDYES IDYES keepModelForgeData IDNO removeModelForgeData

      removeModelForgeData:
        ; The data belongs to the user running the uninstaller even after a per-machine
        ; install, where $APPDATA points at ProgramData. goose reads APPDATA/LOCALAPPDATA
        ; from the environment first (etcetera), so read the same variables here; an unset
        ; variable skips its folders instead of resolving to the drive root.
        Push $0
        Push $1
        ReadEnvStr $0 APPDATA
        ReadEnvStr $1 LOCALAPPDATA
        ${if} $0 != ""
          ; Desktop app data (settings, credential store, recent projects, logs, snapshots).
          RMDir /r "$0\ModelForge"
          ; Kernel configuration and sessions.
          RMDir /r "$0\Block\goose"
          ; Without /r RMDir only removes an empty directory.
          RMDir "$0\Block"
        ${endIf}
        ${if} $1 != ""
          RMDir /r "$1\modelforge-updater"
          ; Kernel cache.
          RMDir /r "$1\Block\goose"
          RMDir "$1\Block"
        ${endIf}
        Pop $1
        Pop $0
        ; Missing folders and a non-empty "Block" parent only set the error flag.
        ClearErrors
        DetailPrint "已删除 ModelForge 的配置与会话数据"
        Goto modelForgeDataDone

      keepModelForgeData:
        DetailPrint "已保留 ModelForge 的配置与会话数据"

      modelForgeDataDone:
    ${endIf}
  ${endIf}
!macroend
