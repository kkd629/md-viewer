# MD Viewer

마크다운 뷰어 / 에디터 (Windows · Electron)

<img width="1918" height="1030" alt="image" src="https://github.com/user-attachments/assets/64237faf-5ea0-4514-bb93-8c786d764c67" />

## 다운로드 (그냥 쓰실 분)

[**Releases**](../../releases) 에서 최신 **`MD Viewer Setup.exe`** 를 받아 실행하면 설치됩니다
(관리자 권한 불필요, 바탕화면·시작메뉴 바로가기 생성). 제어판에서 깔끔하게 제거할 수 있습니다.

> ⚠️ 초록색 **Code ▸ Download ZIP**(소스 코드)로 받으면 실행되지 않습니다. 그건 개발용 소스라
> `node_modules`(라이브러리)가 없어서 그대로는 안 돌아갑니다. **그냥 쓰실 거면 위 Setup.exe** 를 받으세요.

## 실행 방법 (소스에서 개발/실행)

**`MD Viewer 실행.bat`** 더블클릭 — 소스로 받았다면 처음 실행 시 자동으로 `npm install` +
빌드를 수행합니다(**[Node.js](https://nodejs.org) 필요**). 이후엔 바로 실행됩니다.

또는 터미널에서:

```powershell
npm start          # 빌드 후 실행
```

소스(`src/renderer.js`, CSS, HTML)를 수정했다면 다시 빌드해야 합니다:

```powershell
npm run build      # renderer/bundle.js 재생성
```

## 단축키

| 기능 | 단축키 |
|------|--------|
| 편집 / 분할 / 미리보기 | `Ctrl+1` / `Ctrl+2` / `Ctrl+3` |
| 폴더 전체 검색 | `Ctrl + Shift + F` |
| 글꼴 크게 / 작게 | `Ctrl + +` / `Ctrl + -` |
| Claude 패널 | `Ctrl + J` |

## 기능

- **3가지 모드** - 편집 / 분할 / 미리보기 (상단 버튼 또는 단축키)
- **탭** - 여러 문서를 동시에 열고 전환, 탭의 ✕ 또는 휠클릭(가운데)으로 닫기. 탭에도 형식 아이콘(📝/📄/🔧/🌐) 표시. **탭 이름 더블클릭 → 파일명 변경**(실제 파일도 함께 rename). 탭이 많아 넘치면 **마우스 휠 좌우 스크롤 + 양끝 ‹ › 버튼**으로 이동(현재 탭은 자동으로 보이게 스크롤)
- **서식 툴바** - 굵게/기울임/제목/목록/표/링크/코드블록 등 버튼
- **설정 페이지** - 테마 세트(옵시디언 다크 / 라이트 / 노르드 / 솔라라이즈드), 글꼴 크기, 자동 저장, 문법 색상 on/off
- **파일 형식** - `.md`/`.markdown`/`.mdown`·`.txt`·`.json`·**`.html`/`.htm`** 열기·트리 탐색·검색 지원. 트리/탭에서 형식별 아이콘 구분(📝 md · 📄 txt · 🔧 json · 🌐 html)
- **HTML 듀얼 뷰** - `.html` 파일은 분할 모드에서 **왼쪽=소스, 오른쪽=실제 렌더링된 페이지**(iframe). CSS·JavaScript·상대경로 리소스까지 실제 브라우저처럼 렌더되고, 편집하면 실시간 반영
- **문단 복사** - 미리보기에서 문단/표/코드 위에 마우스를 올리면 📋 복사 버튼이 떠서 원본 마크다운을 클립보드로 복사
- **Claude Code 연동** - `Ctrl+J`로 오른쪽에 Claude 채팅 패널을 열어 노트를 컨텍스트로 질문·요약·수정을 요청
  - **질문 대상 선택** - 현재 노트 / 폴더 전체(.md) / 특정 파일 중에서 선택해서 물어봄
  - **모델 선택** - 기본 / Opus / **Sonnet(기본값)** / Haiku
  - **단순 질문/요약**(예: "이 노트 요약해줘") → 답변만
  - **수정 요청**(예: "맨 아래 결론 추가해줘") → 답변 + 아래에 **"✅ 반영하기"** 버튼 → 누르면 노트에 적용·저장 (대상이 안 열린 파일이면 자동으로 열어서 반영)
  - **되돌리기** - 반영 후 버튼이 **"↩ 되돌리기"**로 바뀌어, 한 번 누르면 반영 전 상태로 복구(다시 누르면 재반영). 토글 가능
  - **라이브 스트리밍** - 답변이 생성되는 대로 실시간 표시(타이핑 효과 + 커서)
  - Claude는 파일을 직접 건드리지 않음(읽기 전용). 적용 여부는 항상 사용자가 버튼으로 결정 → 안전
- 라인 넘버, 단어/글자 수, 커서 위치 상태바, 외부 링크는 기본 브라우저로 열기

## Claude Code 연동 준비

Claude 패널을 쓰려면 PC에 **Claude Code CLI**가 설치되어 PATH에 있어야 합니다
(`claude --version` 으로 확인). 별도 로그인은 필요 없고, 이미 설치된 Claude Code의
로그인 정보를 그대로 사용합니다. 패널에서 질문하면 현재 노트 내용과 열린 폴더를
컨텍스트로 `claude -p` 를 호출합니다. 읽기 도구(Read/Glob/Grep)만 허용하므로
Claude가 파일을 직접 수정하지 않으며, 수정안은 **"반영하기"** 버튼으로만 적용됩니다.

## 설치 파일(.exe) 빌드

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"   # 코드서명 끔
npm run dist
```

`dist\MD Viewer Setup.exe` (단일 설치 파일)가 생성됩니다. 실행하면 per-user로 설치되고
바탕화면·시작메뉴 바로가기가 만들어집니다(작업표시줄 고정 가능).

> 앱 아이콘 원본은 `build\icon.svg` 입니다. 디자인을 바꾸면 `node build\render-icon.js`
> 로 `build\icon.ico` 를 다시 만든 뒤 `npm run dist` 하세요.
>
> 빌드 중 electron-builder의 winCodeSign 압축 해제가 심볼릭 링크 권한 문제로 실패하면,
> `node_modules\7zip-bin\win\x64\7za.exe` 로 캐시(`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\*.7z`)를
> `winCodeSign-2.6.0\` 폴더에 직접 풀어두면 됩니다(미서명 Windows 빌드엔 무관한 macOS 심링크만 실패).

## 글꼴

- **편집기**: [D2Coding](https://github.com/naver/d2codingfont) - Naver, SIL Open Font License 1.1 (앱 내장).
- **UI·미리보기**: 시스템 글꼴(맑은 고딕 / Segoe UI).

