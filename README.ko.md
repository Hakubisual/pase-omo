<div align="center">

# pase-omo

**[Paseo](https://getpaseo.com) 안에서 네이티브로 도는 [OmO 5](https://github.com/code-yeongyu).**

워크플로우가 웨이브 단위로 진행되는 걸 보드로 보고, OmO 질문엔 Paseo 질문 카드로 답하고,
투두는 턴마다 한 장으로 깔끔하게. 데스크탑에서도, 폰에서도.

[English](README.md) · [한국어](README.ko.md)

</div>

![OmO 보드가 열린 Paseo: 7개 웨이브·15개 노드 워크플로우, 실행 중인 노드 3개, 노드 상세와 활동 기록](docs/images/demo.png)

---

## 새로워진 점: OmO 5 네이티브

OmO 5에서 호스트와 대화하는 방식이 바뀌었고, 이 플러그인은 이제 그 방식을 그대로 쓴다.

- **엔진이 OmO 5다.** 세션은 OmO의 기본 모델로 시작하고, 모델 선택기에는 OmO가 등록한
  모델이 전부 뜨고, `task()`로 띄운 자식 세션은 진짜 Paseo 세션으로 보인다.
- **질문은 Paseo 기본 질문 카드로.** OmO가 뭔가 물으면 채팅에 Paseo가 직접 질문 카드를
  그린다. 선택지를 고르거나, 직접 적거나, 여러 질문에 한 번에 답하면 답이 바로 OmO로
  간다. 플러그인의 별도 승인 버튼은 없앴다 — 답은 채팅에서 하면 된다.
- **투두는 턴마다 한 장.** OmO 투두 도구를 부를 때마다 채팅에 행이 쌓이던 게 사라졌다.
  턴이 끝나면 카드 한 장, 도는 동안에는 컴포저의 작업 칩이 진행을 보여준다.
- **워크플로우 실행을 위한 새 보드 뷰** — 아래.

## 워크플로우 보드

`workflow` 실행은 보드로 열린다. 웨이브마다 한 열, 노드마다 카드 한 장, 그리고 왼쪽에서
오른쪽으로 작업을 나르는 엣지.

![OmO 보드의 워크플로우 실행: 7개 웨이브, 15개 노드 중 8개 완료·3개 실행 중](docs/images/board.png)

![실행 중인 노드로 들어가는 엣지를 따라 점이 흐르는 모습](docs/images/board-flow.gif)

- **지금 도는 걸 따라간다.** 보드는 지금 실행 중인 세션을 골라 그 세션의 실행 하나만
  보여준다. 세션 목록과 통계 바는 비켜 있고, 필요하면 *Other sessions*로 연다.
- **움직임은 일이 일어나는 곳에만.** 실행 중인 노드로 들어가는 엣지에 점이 흐른다.
  끝난 엣지는 초록 실선, 대기 중인 엣지는 회색이고, 도는 게 없으면 애니메이션도 멈춘다.
- **카드마다 그 노드가 뭘 하는지 적혀 있다:** 상태, 경과 시간과 초당 토큰, 실행한
  카테고리와 모델, 실시간 진행 줄.
- **웨이브가 스스로 센다** — `Wave 4 · 0/2 settled · 2 running` — 그리고 실행 헤더는
  전체가 얼마나 진행됐는지 보여준다.

노드를 누르면 상세가 열린다 — 턴 수, 도구 호출 수, 모델, 무엇을 하라고 받았는지,
지금 뭘 하는지:

![보드 아래 열린 노드 인스펙터](docs/images/board-inspector.png)

서브태스크는 보드 옆 작은 서랍에 들어가서 그래프를 밀어내지 않는다. **Subtasks** 버튼으로
열고 닫고, 실행 중인 작업이 위로 온다:

![보드 옆에 열린 서브태스크 서랍](docs/images/board-subtasks.png)

보드 아래 활동 기록에는 시작, 완료, 오류, 실시간 진행이 최신순으로 쌓인다. 한 줄을
누르면 그 노드로 이동한다.

이전 카드 뷰는 **Cards**에서 그대로 볼 수 있다.

## 채팅에서

OmO 질문은 Paseo 기본 질문 카드로 온다:

<img src="docs/images/chat-question.png" width="720" alt="오프닝 루프를 묻는 Paseo 질문 카드, 선택지 두 개">

체크리스트를 따라 일한 턴은 투두 카드 한 장으로 끝난다:

<img src="docs/images/chat-todo.png" width="720" alt="턴 끝의 투두 카드 한 장: 두 개 완료, 하나 진행 중">

## 폰에서

폰에서도 같은 보드다 — 같은 카드, 같은 흐름. 글자를 줄이는 대신 옆으로 스크롤한다.
서브태스크 서랍은 공간이 있는 그래프 아래로 내려간다.

<table>
<tr>
<td width="33%"><img src="docs/images/mobile-board.png" alt="폰에서 본 보드"></td>
<td width="33%"><img src="docs/images/mobile-running.png" alt="폰에서 본 실행 중인 웨이브"></td>
<td width="33%"><img src="docs/images/mobile-inspector.png" alt="폰에서 본 노드 인스펙터"></td>
</tr>
<tr>
<td align="center"><sub>보드</sub></td>
<td align="center"><sub>실행 중인 웨이브</sub></td>
<td align="center"><sub>노드 상세</sub></td>
</tr>
<tr>
<td width="33%"><img src="docs/images/mobile-subtasks.png" alt="폰에서 본 서브태스크 서랍"></td>
<td width="33%"><img src="docs/images/mobile-question.png" alt="폰에서 본 OmO 질문"></td>
<td width="33%"><img src="docs/images/mobile-todo.png" alt="폰에서 본 투두 카드"></td>
</tr>
<tr>
<td align="center"><sub>서브태스크</sub></td>
<td align="center"><sub>질문 카드</sub></td>
<td align="center"><sub>투두 카드</sub></td>
</tr>
</table>

## 그 밖의 기능

| 표면 | 하는 일 |
| --- | --- |
| **OmO 프로바이더** | Paseo 모델 선택기의 OmO. 스트리밍, 도구 호출, 자식 세션이 Paseo 채팅으로 |
| **OmO DAG** | 보드와 카드 뷰. 사이드바, 명령 센터, 워크스페이스 탭 바에서 연다 |
| **채팅 DAG 카드** | 실행 하나당 타임라인 카드 한 장, 실행이 끝나면 그린다 |
| **OmO 승인** | 현재 에이전트의 대기 중인 확인, 선택, 질문 |
| **OmO 폴더** | 세션, 실행, 작업을 트리로 묶어 둘러보기 |
| **OmO 업데이트** | 모든 OmO 세션을 멈추고, OmO를 업데이트하고, 하던 곳에서 이어서 재개 |
| **하네스 접기** | OmO 하네스 XML, 메모리 노트, 오류 봉투를 작은 바로 접어서 표시 |

---

## 요구 사항

- **Paseo 0.8.0 이상** (`paseo-plugin.json`에 선언). 플러그인은 현재 SDK인 0.10.3에
  맞춰 빌드하고 테스트하며, 0.11.0-beta.3에서도 테스트가 모두 통과한다.
- **OmO 5** 설치. 플러그인은 OmO의 Bun 글로벌 설치
  (`~/.bun/install/global/node_modules/omo-ai/bin/omo.js`)를 먼저 찾고, 그다음 `PATH`의
  `omo`를 찾는다.

## 설치

Paseo 데몬이 도는 머신에서:

```bash
paseo plugin add Hakubisual/pase-omo --ref ko
```

`--ref ko`는 한국어 UI 브랜치다. 영어 UI는 `--ref`를 빼거나 `--ref main`.

### 관리

```bash
paseo plugin ls              # 설치된 플러그인과 런타임 id
paseo plugin status          # 설치본과 받을 수 있는 버전 비교
paseo plugin update omo      # 이 플러그인 업데이트
paseo plugin logs omo        # 최근 플러그인 로그
```

런타임 id는 **`omo`**다. 데몬에서 이미 쓰는 id라면 설치할 때 `--id`를 넘긴다.

업데이트한 뒤에는 트레이에서 Paseo를 완전히 종료하고 다시 켜야 앱과 데몬 모두 새 코드를
읽는다.

> **추가하는 플러그인은 믿을 수 있어야 한다.** Paseo 플러그인은 샌드박스가 없다. 서버
> 코드는 데몬 사용자 권한으로, 클라이언트 코드는 Paseo 앱 안에서 돈다.

---

## 개발

```bash
bun install
bun x tsc --noEmit    # 타입
bun x vitest run      # 테스트
```

`build` 단계가 없어서 Paseo가 설치할 때 소스를 바로 컴파일한다.

| 경로 | 역할 |
| --- | --- |
| `index.client.tsx` | 클라이언트 기여 전부: 패널, 서피스, 명령, 렌더러, pill |
| `index.server.ts` | 데몬 쪽: 에이전트 프로바이더, DAG·승인 RPC, 타임라인 퍼블리셔 |
| `client/` | React Native 뷰 — 보드, 그래프 레이아웃, DAG 패널, 승인, 폴더, 투두 카드 |
| `server/` | 프로바이더, 세션 저장소, DAG 스냅샷 리더, 워커 매니저 |
| `shared/` | 양쪽이 공유하는 행 스키마와 RPC 계약 |

---

## 감사

**[연규 — github.com/code-yeongyu](https://github.com/code-yeongyu)** 님께 진심으로
샤라웃 드립니다. OmO를 만드신 분입니다.

OmO는 제 인생을 바꿔주고 있습니다. 일하는 방식도, 속도도, 한 사람이 하루에 실제로 뭘
만들어낼 수 있는지에 대한 기준 자체를 바꿔놨어요. 이 플러그인도 결국 OmO가 뭘 하고
있는지 *눈으로 보고 싶어서* 만든 거고, 그분의 작업이 없었으면 아예 존재하지 않았을
겁니다. 뭘 만드시는지 꼭 한번 보세요.

OmO 5 지원 PR을 보내주신 분들, 그리고 에이전트가 자기 인터페이스를 통째로 들고 들어올 수 있을 만큼 열린 플러그인
API를 만들어준 [Paseo](https://getpaseo.com) 팀에도 감사드립니다.

이 저장소는 [OmO](https://github.com/code-yeongyu/oh-my-openagent)로 작성했습니다.
그래서 커밋 히스토리에 OmO가 자기 플러그인의 공동 작성자로 남아 있습니다.

---

## 라이선스

MIT
