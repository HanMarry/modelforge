; ModelForge: safe replacement for setInstallModePerUser of app-builder-lib 24.13.3
; (templates/nsis/multiUser.nsh). Included from customWelcomePage / customUnWelcomePage in
; build/installer.nsh, i.e. after multiUser.nsh has defined the macro and before any function
; that inserts it (the install-mode page functions and .onInit / un.onInit) is compiled.
;
; Why: on a fresh per-user install (no InstallLocation under HKCU\Software\<APP_GUID>) the
; template reads the path SHGetKnownFolderPath(FOLDERID_UserProgramFiles) returns with
;
;     System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'
;
; which makes System.dll copy NSIS_MAX_STRLEN WCHARs from a Shell allocation that is only as
; long as the path. Depending on the heap layout the copy runs into unmapped memory and the
; installer dies in .onInit with an access violation in %TEMP%\ns*.tmp\System.dll (fault offset
; 0x1581, exit code 0xC0000005) before it shows a window or writes a file. Seen in the Windows
; smoke runs 36734406076, 36765098000 and 36774508039, for the runner account and for a new
; local user, and reported upstream as electron-userland/electron-builder#8536; fixed upstream
; by #9769 (bounded lstrcpynW copy, commit a356198), which is what this macro does. Drop this
; file once app-builder-lib includes that fix.
;
; Everything else matches the 24.13.3 macro: the registry lookup, the fallback to
; $LocalAppData\Programs and the /D override through StdUtils.GetParameter.

!ifndef MODELFORGE_MULTIUSER_NSH
!define MODELFORGE_MULTIUSER_NSH

!ifndef INSTALL_MODE_PER_ALL_USERS
  ; The template must already have defined what is replaced here; fail the build otherwise
  ; instead of silently shipping the unsafe read again.
  !ifmacrondef setInstallModePerUser
    !error "modelforge-multiuser.nsh: setInstallModePerUser is not defined yet; app-builder-lib's NSIS templates changed"
  !endif
  !ifndef FOLDERID_UserProgramFiles
    !error "modelforge-multiuser.nsh: FOLDERID_UserProgramFiles is not defined; app-builder-lib's NSIS templates changed"
  !endif
  !ifndef KF_FLAG_CREATE
    !error "modelforge-multiuser.nsh: KF_FLAG_CREATE is not defined; app-builder-lib's NSIS templates changed"
  !endif

  !macroundef setInstallModePerUser

  !macro setInstallModePerUser
    StrCpy $installMode CurrentUser
    SetShellVarContext current

    # checks registry for previous installation path
    ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $perUserInstallationFolder != ""
      StrCpy $INSTDIR $perUserInstallationFolder
    ${else}
      StrCpy $0 "$LocalAppData\Programs"
      Push $1
      Push $2
      # UserProgramFiles is the per-user install root and can be a non-default location
      StrCpy $2 0
      System::Call 'SHELL32::SHGetKnownFolderPath(g "${FOLDERID_UserProgramFiles}", i ${KF_FLAG_CREATE}, p 0, *p .r2)i.r1'
      ${If} $1 == 0
        # Copies up to the terminating NUL, at most NSIS_MAX_STRLEN characters.
        System::Call 'KERNEL32::lstrcpynW(w .r0, p r2, i ${NSIS_MAX_STRLEN})p'
      ${endif}
      # SHGetKnownFolderPath may return allocated memory even on failure
      ${If} $2 != 0
        System::Call 'OLE32::CoTaskMemFree(p r2)'
      ${endif}
      Pop $2
      Pop $1
      StrCpy $INSTDIR "$0\${APP_FILENAME}"
    ${endif}

    # allow /D switch to override installation path https://github.com/electron-userland/electron-builder/issues/1551
    ${StdUtils.GetParameter} $R0 "D" ""
    ${If} $R0 != ""
      StrCpy $INSTDIR $R0
    ${endif}
  !macroend
!endif

!endif ; MODELFORGE_MULTIUSER_NSH
