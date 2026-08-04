; Geny connector — Windows installer customization.
;
; Adds ONE decision to the assisted installer: whether this machine uses Geny
; Cloud (the per-agent cloud drive). Default = checked.
;
; The answer is written as a small JSON flag into the app's userData dir, which
; the connector consumes on first run (consumeInstallFlags in main/index.ts)
; and then deletes. A flag file — rather than a registry policy — keeps the
; installer from asserting anything the app itself can't change later.
;
; Prerequisites: none to install. Windows' Cloud Files API (the streaming
; drive) ships with Windows 10 1709+; the connector probes for it at runtime
; (drive-preflight.ts) rather than having the installer guess.
;
; NOTE ON STRUCTURE: electron-builder inserts `customPageAfterChangeDir` in the
; PAGE-DEFINITION section (assistedInstaller.nsh, between MUI_PAGE_DIRECTORY
; and MUI_PAGE_INSTFILES), so that macro may only declare a page — the dialog
; itself must live in ordinary Functions, defined here at top level.

!include nsDialogs.nsh
!include LogicLib.nsh

Var GenyCloudCheckbox
Var GenyCloudChecked

Function GenyCloudPageCreate
  ; Default ON: an empty var means the page has not been visited yet.
  ${If} $GenyCloudChecked == ""
    StrCpy $GenyCloudChecked "1"
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Geny 클라우드 (Geny Cloud)" "에이전트별 클라우드 저장소를 이 PC의 드라이브 폴더와 동기화합니다."

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "켜면 각 에이전트의 클라우드 저장소가 이 PC의 'Geny 드라이브' 폴더로 동기화됩니다. 나중에 접속기 설정에서 언제든지 바꿀 수 있습니다.$\r$\n$\r$\nWhen enabled, each agent's cloud storage syncs to a Geny Drive folder on this PC. You can change this later in the app."
  Pop $0

  ${NSD_CreateCheckbox} 0 48u 100% 12u "Geny 클라우드 사용 (Use Geny Cloud) — 권장"
  Pop $GenyCloudCheckbox
  ${If} $GenyCloudChecked == "1"
    ${NSD_Check} $GenyCloudCheckbox
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function GenyCloudPageLeave
  ${NSD_GetState} $GenyCloudCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $GenyCloudChecked "1"
  ${Else}
    StrCpy $GenyCloudChecked "0"
  ${EndIf}
FunctionEnd

!macro customPageAfterChangeDir
  Page custom GenyCloudPageCreate GenyCloudPageLeave
!macroend

!macro customInstall
  ; Electron resolves userData to %APPDATA%\geny-connector (package.json
  ; "name"); the app reads the flag from exactly that path.
  CreateDirectory "$APPDATA\geny-connector"
  ${If} $GenyCloudChecked == "0"
    FileOpen $0 "$APPDATA\geny-connector\install-flags.json" w
    FileWrite $0 '{"cloudOptIn": false}'
    FileClose $0
  ${Else}
    FileOpen $0 "$APPDATA\geny-connector\install-flags.json" w
    FileWrite $0 '{"cloudOptIn": true}'
    FileClose $0
  ${EndIf}
!macroend

!macro customUnInstall
  ; User data (drive folders, config) is deliberately left alone; only our
  ; one-shot install flag is cleaned up.
  Delete "$APPDATA\geny-connector\install-flags.json"
!macroend
