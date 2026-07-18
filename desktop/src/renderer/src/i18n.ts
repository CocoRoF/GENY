// ─────────────────────────────────────────────────────────────────────────────
// i18n — ko/en message catalog + a tiny translator for the settings UI.
//
// Every user-facing string in the renderer settings surface (ControlApp.tsx)
// lives here keyed by a dotted name; the native chrome (tray/menu/dialogs) has
// its own small ko/en map in main/index.ts. Keep the two consistent: 접속기 =
// connector, 세션 = session, 아바타 = avatar, 오버레이 = overlay, 화면 캡처 =
// screen capture, 로컬 컴퓨터 제어 = Local Computer Use.
// ─────────────────────────────────────────────────────────────────────────────

export type Lang = 'ko' | 'en'

type Entry = { ko: string; en: string }

export const messages: Record<string, Entry> = {
  // ── header + tabs ──
  'app.subtitle': { ko: 'VTuber 데스크톱 접속기', en: 'VTuber desktop connector' },
  'tab.account': { ko: '계정', en: 'Account' },
  'tab.voice': { ko: '음성', en: 'Voice' },
  'tab.control': { ko: '제어', en: 'Control' },
  'tab.mcp': { ko: 'MCP', en: 'MCP' },
  'tab.app': { ko: '앱', en: 'App' },

  // ── hotkey capture (shared) ──
  'hotkey.recording': { ko: '키 조합을 누르세요…  (Esc 취소)', en: 'Press a key combination…  (Esc to cancel)' },
  'hotkey.idle': { ko: '클릭한 뒤 키 조합을 누르세요', en: 'Click, then press a key combination' },
  'hotkey.registered': { ko: '✓ 단축키가 등록되었습니다', en: '✓ Hotkey registered' },
  'hotkey.conflict': { ko: '✗ 다른 앱과 충돌 — 다른 조합을 시도하세요', en: '✗ Conflicts with another app — try a different combination' },

  // ── status messages (account) ──
  'status.initial': { ko: '연결 상태를 확인하세요', en: 'Check the connection status' },
  'status.connecting': { ko: '서버에 연결하는 중…', en: 'Connecting to the server…' },
  'status.connectedAuthed': { ko: '연결됨 · 로그인 상태', en: 'Connected · Signed in' },
  'status.connectedLoginNeeded': { ko: '연결됨 · 로그인 필요', en: 'Connected · Sign-in required' },
  'status.connectedSetupNeeded': { ko: '연결됨 · 초기 설정 필요', en: 'Connected · Initial setup required' },
  'status.connectFailed': { ko: '연결 실패 — {msg}', en: 'Connection failed — {msg}' },
  'status.loggingIn': { ko: '로그인하는 중…', en: 'Signing in…' },
  'status.loginFailedHttp': { ko: '로그인 실패 — HTTP {code}', en: 'Sign-in failed — HTTP {code}' },
  'status.loginOk': { ko: '{username} 님으로 로그인됨 — 아바타를 불러옵니다', en: 'Signed in as {username} — loading the avatar' },
  'status.loginError': { ko: '오류 — {msg}', en: 'Error — {msg}' },
  'status.loggedOut': { ko: '로그아웃되었습니다', en: 'Signed out' },

  // ── account tab ──
  'account.serverCard': { ko: '서버 연결', en: 'Server connection' },
  'account.serverUrlLabel': { ko: '서버 주소', en: 'Server URL' },
  'account.checkConnection': { ko: '연결 확인', en: 'Check connection' },
  'account.openInBrowser': { ko: '브라우저에서 Geny 서버 열기', en: 'Open Geny server in browser' },
  'account.accountCard': { ko: '계정', en: 'Account' },
  'account.loggedIn': { ko: '로그인됨 · 토큰이 키체인에 안전하게 저장됨', en: 'Signed in · Token securely stored in the keychain' },
  'account.logout': { ko: '로그아웃', en: 'Sign out' },
  'account.idLabel': { ko: '아이디', en: 'Username' },
  'account.passwordLabel': { ko: '비밀번호', en: 'Password' },
  'account.loginToHost': { ko: '{host} 에 로그인', en: 'Sign in to {host}' },
  'account.login': { ko: '로그인', en: 'Sign in' },

  // ── voice tab: push-to-talk ──
  'voice.pttCard': { ko: '푸시투토크 단축키', en: 'Push-to-talk hotkey' },
  'voice.pttHint': {
    ko: '탭하면 마이크가 켜지고, 다시 탭하면 꺼지거나 아바타의 말을 끊습니다. 아래를 클릭한 뒤 원하는 키 조합을 누르세요.',
    en: 'Tap to turn the mic on; tap again to turn it off or interrupt the avatar. Click below, then press the key combination you want.',
  },

  // ── voice tab: TTS ──
  'voice.ttsCard': { ko: 'TTS · 음성 출력', en: 'TTS · Voice output' },
  'voice.volume': { ko: '볼륨', en: 'Volume' },
  'voice.volumeHint': { ko: '아바타 창의 음성 출력 볼륨입니다.', en: 'The voice output volume of the avatar window.' },

  // ── voice tab: audio devices (sound driver in/out) ──
  'voice.deviceCard': { ko: '오디오 장치 (출력 · 입력)', en: 'Audio devices (output · input)' },
  'voice.outputDevice': { ko: '출력 (TTS 스피커)', en: 'Output (TTS speaker)' },
  'voice.inputDevice': { ko: '입력 (마이크)', en: 'Input (microphone)' },
  'voice.deviceDefault': { ko: '시스템 기본값', en: 'System default' },
  'voice.deviceOffline': { ko: ' (오프라인)', en: ' (offline)' },
  'voice.deviceRefresh': { ko: '장치 목록 새로고침', en: 'Refresh device list' },
  'voice.deviceHint': {
    ko: '선택한 장치는 이름으로 기억되고, 재접속하거나 장치가 늦게 켜질 때(예: VoiceMeeter가 나중에 시작) 자동으로 다시 연결됩니다. 목록이 비어 있으면 마이크 권한을 허용한 뒤 새로고침하세요.',
    en: 'The chosen device is remembered by name and re-applied automatically on reconnect or when it appears late (e.g. VoiceMeeter starting after Geny). If the list is empty, allow mic permission then refresh.',
  },

  // ── voice tab: subtitles ──
  'voice.subtitlesCard': { ko: '대사창 (자막)', en: 'Dialogue box (subtitles)' },
  'voice.subtitlesToggle': { ko: '아바타 하단에 대사 표시', en: 'Show dialogue at the bottom of the avatar' },
  'voice.subtitleSpeed': { ko: '글자 출력 속도', en: 'Character reveal speed' },
  'voice.subtitleSpeedDisplay': { ko: '{sec}초/글자', en: '{sec}s/char' },
  'voice.subtitleHint': {
    ko: '대사가 한 글자씩 흘러나오는 속도입니다(기본 0.10초/글자 — 왼쪽=빠름, 오른쪽=느림). 화면 캡처·자동 대화 트리거로 한 번에 온 발화도 이 속도로 앞에서부터 타이핑됩니다. 길어지면 위에서부터 잘리고, 다 흐른 뒤 약 3초 후 사라집니다(음성 켜져 있으면 음성이 끝난 뒤).',
    en: 'How fast the dialogue reveals one character at a time (default 0.10s/char — left = faster, right = slower). Utterances that arrive all at once from a screen-capture or auto-conversation trigger are also typed out from the start at this pace. Longer text is trimmed from the top and disappears about 3 seconds after it finishes (or after the voice ends, if voice is on).',
  },

  // ── voice tab: STT ──
  'voice.sttCard': { ko: 'STT · 음성 입력', en: 'STT · Voice input' },
  'voice.sttSensitivity': { ko: '민감도 (낮을수록 더 민감)', en: 'Sensitivity (lower is more sensitive)' },
  'voice.sttSilence': { ko: '발화 종료 대기', en: 'End-of-speech wait' },
  'voice.soundCorrection': { ko: '사운드 보정', en: 'Sound processing' },
  'voice.echoCancellation': { ko: '에코 제거', en: 'Echo cancellation' },
  'voice.noiseSuppression': { ko: '노이즈 억제', en: 'Noise suppression' },
  'voice.autoGain': { ko: '자동 게인', en: 'Auto gain' },

  // ── control tab: Local Computer Use ──
  'control.card': { ko: '로컬 컴퓨터 제어', en: 'Local Computer Use' },
  'control.hint': {
    ko: '이 접속기가 프록시가 되어, 서버에 떠 있는 Geny 에이전트가 내 컴퓨터를 보고 조작할 수 있게 합니다. 실행은 항상 이 컴퓨터에서 아래 동의에 따라 이뤄집니다(서버는 중계만 함). 접속기가 꺼지면 안전하게 차단됩니다. 에이전트가 실제로 쓰려면 해당 환경에서도 이 기능을 켜야 합니다.',
    en: 'This connector acts as a proxy so the Geny agent running on the server can see and operate your computer. Actions always run on this computer according to the consent settings below (the server only relays). It is safely blocked when the connector is off. To actually use it, the agent must also enable this feature in its environment.',
  },
  'control.masterToggle': { ko: '로컬 컴퓨터 제어 허용 (마스터)', en: 'Allow Local Computer Use (master)' },
  'control.capScreen': { ko: '화면 보기 (캡처·창 목록, 읽기 전용)', en: 'View screen (capture · window list, read-only)' },
  'control.capInput': { ko: '입력 조작 (타이핑·키·클릭)', en: 'Input control (type · keys · click)' },
  'control.capApps': { ko: '앱·URL 열기', en: 'Open apps · URLs' },
  'control.capClipboard': { ko: '클립보드 쓰기', en: 'Write clipboard' },
  'control.consentTitle': { ko: '조작 동의 방식', en: 'Consent mode' },
  'control.consentAsk': { ko: '항상 확인', en: 'Always ask' },
  'control.consentSession': { ko: '이 세션 동안 허용', en: 'Allow for this session' },
  'control.consentAuto': { ko: '자동 허용', en: 'Auto-allow' },
  'control.consentHint': {
    ko: '화면 보기는 읽기 전용이라 확인 없이 즉시 동작합니다. 타이핑·클릭·앱 열기·클립보드는 위 설정을 따릅니다. {ask}이 가장 안전하며, 확인 창에서 “이 세션 동안 허용”을 누르면 그 동작은 접속기를 끌 때까지 다시 묻지 않습니다. {auto}은 매우 위험하니 신뢰하는 작업에만 쓰세요.',
    en: 'Viewing the screen is read-only and runs immediately without a prompt. Typing, clicking, opening apps, and clipboard follow the setting above. {ask} is the safest; pressing “Allow for this session” in a prompt stops asking for that action until you turn the connector off. {auto} is very dangerous — use it only for trusted tasks.',
  },
  'control.consentHint.ask': { ko: '항상 확인', en: 'Always ask' },
  'control.consentHint.auto': { ko: '자동 허용', en: 'Auto-allow' },

  // ── mcp tab ──
  'mcp.serversCard': { ko: '로컬 MCP 서버', en: 'Local MCP servers' },
  'mcp.serversHint': {
    ko: '내 컴퓨터에서 도는 MCP 서버를 등록하면, 이 접속기가 통로가 되어 서버의 Geny 에이전트가 그 도구를 사용할 수 있습니다(로컬 파일·앱·DB 등). 등록한 서버는 이 컴퓨터에만 저장되고, 서버에는 도구 목록만 전달됩니다.',
    en: 'Register an MCP server running on your computer, and this connector becomes the channel through which the Geny agent on the server can use its tools (local files, apps, databases, etc.). Registered servers are stored only on this computer; only the tool list is sent to the server.',
  },
  'mcp.empty': { ko: '등록된 MCP 서버가 없습니다.', en: 'No MCP servers registered.' },
  'mcp.test': { ko: '테스트', en: 'Test' },
  'mcp.remove': { ko: '삭제', en: 'Remove' },
  'mcp.testing': { ko: '테스트 중…', en: 'Testing…' },
  'mcp.testOk': { ko: '연결됨 · 도구 {count}개', en: 'Connected · {count} tools' },
  'mcp.testFail': { ko: '실패: {error}', en: 'Failed: {error}' },
  'mcp.testFailUnknown': { ko: '알 수 없음', en: 'unknown' },
  'mcp.addCard': { ko: '서버 추가', en: 'Add server' },
  'mcp.namePlaceholder': { ko: '이름 (예: filesystem)', en: 'Name (e.g. filesystem)' },
  'mcp.commandPlaceholder': {
    ko: '명령 (예: npx -y @modelcontextprotocol/server-filesystem /path)',
    en: 'Command (e.g. npx -y @modelcontextprotocol/server-filesystem /path)',
  },
  'mcp.urlPlaceholder': { ko: 'URL (예: http://localhost:3000/mcp)', en: 'URL (e.g. http://localhost:3000/mcp)' },
  'mcp.add': { ko: '추가', en: 'Add' },
  'mcp.addHint': {
    ko: 'stdio는 로컬에서 명령으로 실행되는 MCP 서버, http는 이미 떠 있는 MCP 엔드포인트입니다. 저장하면 연결된 서버의 각 도구가 에이전트에게 {name} 형태의 개별 도구로 바로 나타납니다 — 별도 탐색 없이 즉시 사용됩니다.',
    en: 'stdio is an MCP server launched locally by a command; http is an already-running MCP endpoint. Once saved, each tool on a connected server appears to the agent as an individual {name} tool — usable immediately, no discovery step.',
  },
  'mcp.master': { ko: '로컬 MCP 사용', en: 'Enable local MCP' },
  'mcp.masterOffHint': {
    ko: '꺼져 있는 동안 에이전트에게 로컬 MCP 도구가 보이지 않습니다. 서버 설정은 그대로 보존됩니다.',
    en: 'While off, no local MCP tools are visible to the agent. Server configs are kept.',
  },
  'mcp.summary': { ko: '연결 {servers}개 서버 · 도구 {tools}개', en: '{servers} connected · {tools} tools' },
  'mcp.rowConnected': { ko: '연결됨', en: 'connected' },
  'mcp.rowIdle': { ko: '대기', en: 'idle' },
  'mcp.rowDisabled': { ko: '꺼짐', en: 'off' },
  'mcp.rowTools': { ko: '도구 {count}개', en: '{count} tools' },
  'mcp.edit': { ko: '편집', en: 'Edit' },
  'mcp.editCard': { ko: '서버 편집: {name}', en: 'Edit server: {name}' },
  'mcp.envLabel': { ko: '환경변수 (줄마다 KEY=VALUE)', en: 'Environment (KEY=VALUE per line)' },
  'mcp.envPlaceholder': { ko: 'API_KEY=xxxx', en: 'API_KEY=xxxx' },
  'mcp.headersLabel': { ko: '헤더 (줄마다 Key: Value)', en: 'Headers (Key: Value per line)' },
  'mcp.headersPlaceholder': { ko: 'Authorization: Bearer xxxx', en: 'Authorization: Bearer xxxx' },
  'mcp.save': { ko: '저장', en: 'Save' },
  'mcp.cancel': { ko: '취소', en: 'Cancel' },
  'mcp.testOkNames': { ko: '연결됨 · 도구 {count}개: {names}', en: 'Connected · {count} tools: {names}' },

  // ── app tab: quick chat ──
  'app.quickChatCard': { ko: '빠른 채팅 단축키', en: 'Quick chat hotkey' },
  'app.quickChatHint': {
    ko: '어디서든 이 단축키를 누르면 입력창이 떠오르고, 메시지를 입력해 현재 VTuber에게 바로 보냅니다. 아래를 클릭한 뒤 원하는 키 조합을 누르세요. 자주 안 쓰는 조합을 권장합니다(기본: Cmd/Ctrl+Shift+Enter).',
    en: 'Press this hotkey from anywhere to bring up an input bar and send a message straight to the current VTuber. Click below, then press the key combination you want. An uncommon combination is recommended (default: Cmd/Ctrl+Shift+Enter).',
  },

  // ── app tab: screen capture ──
  'app.captureCard': { ko: '화면 캡처 관찰', en: 'Screen capture observation' },
  'app.captureInterval': { ko: '캡처 주기', en: 'Capture interval' },
  'app.captureSource': { ko: '볼 화면/창', en: 'Screen/window to view' },
  'app.captureAuto': { ko: '자동 (첫 번째 화면)', en: 'Automatic (first screen)' },
  'app.captureLoading': { ko: '화면 목록을 불러오는 중…', en: 'Loading the screen list…' },
  'app.captureHint': { ko: '캡처는 16:9 · 약 1600×900으로 축소되어 업로드됩니다.', en: 'Captures are downscaled to 16:9 · about 1600×900 before upload.' },
  'app.interval1m': { ko: '1분', en: '1 min' },
  'app.interval3m': { ko: '3분', en: '3 min' },
  'app.interval5m': { ko: '5분', en: '5 min' },
  'app.interval10m': { ko: '10분', en: '10 min' },

  // ── app tab: theme ──
  'app.themeCard': { ko: '화면 테마', en: 'Theme' },
  'app.themeSystem': { ko: '시스템', en: 'System' },
  'app.themeDark': { ko: '다크', en: 'Dark' },
  'app.themeLight': { ko: '라이트', en: 'Light' },
  'app.themeHint': {
    ko: '설정·채팅 창에 함께 적용됩니다. ‘시스템’은 OS 설정을 따릅니다.',
    en: 'Applies to the settings and chat windows. “System” follows the OS setting.',
  },

  // ── app tab: language ──
  'app.langCard': { ko: '언어', en: 'Language' },
  'app.langKo': { ko: '한국어', en: '한국어' },
  'app.langEn': { ko: 'English', en: 'English' },
  'app.langHint': {
    ko: '설정 창의 표시 언어입니다.',
    en: 'The display language of the settings window.',
  },

  // ── app tab: auto-update ──
  'app.updateCard': { ko: '자동 업데이트', en: 'Auto-update' },
  'app.updateToggle': { ko: '자동 업데이트', en: 'Auto-update' },
  'app.updateHintOn': { ko: '새 버전을 자동으로 내려받아 재시작 시 설치합니다.', en: 'Automatically downloads new versions and installs them on restart.' },
  'app.updateHintOff': { ko: '자동 설치는 끄고, 새 버전이 있으면 알림만 띄웁니다.', en: 'Auto-install is off; only notifies when a new version is available.' },
  'app.updateCheckNow': { ko: '지금 업데이트 확인', en: 'Check for updates now' },

  // ── app tab: launch on system startup ──
  'app.autostartCard': { ko: '시작 프로그램', en: 'Startup' },
  'app.autostartToggle': { ko: '시스템 시작 시 자동 실행', en: 'Launch on system startup' },
  'app.autostartHint': { ko: '컴퓨터에 로그인하면 Geny 접속기가 자동으로 실행됩니다.', en: 'Geny connector launches automatically when you log in to your computer.' },

  // ── app tab: window/avatar positions ──
  'app.positionsCard': { ko: '창 · 아바타 위치', en: 'Window · Avatar positions' },
  'app.positionsHint': {
    ko: '아바타·채팅·설정 창의 위치/크기와 아바타 확대·이동을 기본값으로 되돌립니다. 멀티모니터나 배율(100%/150%) 변경으로 창이 화면 밖으로 나가거나 깨졌을 때 사용하세요.',
    en: 'Resets the position/size of the avatar, chat, and settings windows and the avatar zoom/pan to defaults. Use this when a multi-monitor or scaling (100%/150%) change pushes a window off-screen or breaks it.',
  },
  'app.positionsReset': { ko: '창 · 아바타 위치 초기화', en: 'Reset window · avatar positions' },
  'app.positionsResetDone': { ko: '✓ 기본 위치로 되돌렸습니다', en: '✓ Reset to default positions' },

  // ── app tab: about ──
  'app.aboutCard': { ko: '정보', en: 'About' },
  'app.version': { ko: '버전', en: 'Version' },
  'app.server': { ko: '서버', en: 'Server' },
  'app.restart': { ko: '접속기 재시작', en: 'Restart connector' },

  // ── overlay window (logged-out placeholder + dock handle) ──
  'overlay.loginHint': {
    ko: '로그인하면 여기에 아바타가 떠요 — 트레이 아이콘 → 설정/채팅 열기',
    en: 'Sign in and the avatar appears here — tray icon → open settings/chat',
  },
  'overlay.handleTitle': { ko: '드래그: 이동 · 더블클릭: 설정 열기', en: 'Drag: move · Double-click: open settings' },

  // ── quick-chat bar ──
  'qc.placeholder': { ko: '현재 VTuber에게 보낼 메시지…', en: 'Message to send to the current VTuber…' },
  'qc.sendAria': { ko: '전송', en: 'Send' },
  'qc.sendFailed': { ko: '전송 실패', en: 'Failed to send' },
  'qc.sent': { ko: '✓ 전송됨 — VTuber가 답합니다', en: '✓ Sent — the VTuber will reply' },
  'qc.sending': { ko: '전송 중…', en: 'Sending…' },
  'qc.footSend': { ko: '전송', en: 'send' },
  'qc.footNewline': { ko: '줄바꿈', en: 'newline' },
  'qc.footClose': { ko: '닫기', en: 'close' },
}

/**
 * Build a translator for `lang`. `t('a.key', { name: 'x' })` returns the string
 * for the language, interpolating `{name}` tokens, and falls back to the key if
 * the key is unknown (so a missing translation is visible, not silently blank).
 */
export function makeT(lang: Lang) {
  return (key: string, vars?: Record<string, string | number>): string => {
    const entry = messages[key]
    let s = entry ? entry[lang] : key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
      }
    }
    return s
  }
}
