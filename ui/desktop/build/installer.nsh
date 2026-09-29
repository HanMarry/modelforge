; ModelForge NSIS customisation (spec mathmodel-parity-and-beyond, requirement 7.10).
;
; The uninstaller asks whether to keep the user's configuration and chat sessions.
; Project folders are chosen by the user and live outside the app's data directories,
; so they are never touched here — the prompt says so explicitly.
;
; Answering "yes" (the default) leaves everything in place, which is also what an
; upgrade does, so reinstalling keeps providers, keys and history (requirement 7.5).

!macro customUnInstall
  ; A silent uninstall (upgrade, CI, or /S) must not block on a dialog: keep the data.
  ${ifNot} ${isUpdated}
    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
        "是否保留 ModelForge 的配置、模型密钥与会话记录？$\n$\n选择「是」将保留这些数据，下次安装可继续使用。$\n选择「否」将删除它们。$\n$\n你的项目文件夹不在此范围内，始终不会被删除。" \
        /SD IDYES IDYES keepModelForgeData IDNO removeModelForgeData

      removeModelForgeData:
        ; Desktop app data (settings, credential store, recent projects).
        RMDir /r "$APPDATA\ModelForge"
        RMDir /r "$LOCALAPPDATA\modelforge-updater"
        ; Kernel configuration and sessions (~/.config/goose, ~/.local/share/goose).
        RMDir /r "$PROFILE\.config\goose"
        RMDir /r "$PROFILE\.local\share\goose"
        DetailPrint "已删除 ModelForge 的配置与会话数据"
        Goto modelForgeDataDone

      keepModelForgeData:
        DetailPrint "已保留 ModelForge 的配置与会话数据"

      modelForgeDataDone:
    ${endIf}
  ${endIf}
!macroend
