# tabelog-mcp

An MCP server that lets Claude, Codex, Cursor, or any MCP client search [Tabelog (食べログ)](https://tabelog.com), check online-booking availability, and book restaurants in Japan. It drives a real Chrome on your own computer, signed in to your own Tabelog account, and it keeps a local memory of your bookings.

An example session (the booking details are illustrative):

```
You: Find sushi near Ginza for 2 this Saturday around 7pm, under ¥30,000, and book the best one with a counter seat.

Agent: search_restaurants(area: 銀座, keyword: 寿司, date: 2026-10-24, time: 19:00, party: 2, budget_max_yen: 30000)
       → 126 results; はっこく 3.82 has 17:30 and 18:00 open, 19:00 full …
       get_availability(…はっこく…, date: 2026-10-24, party: 2) → 17:30, 18:00
       prepare_booking(…, time: 18:00, party: 2, purpose: personal)
       → ready: はっこく, 2026年10月24日(土) 18:00, 2名, おまかせ ¥33,000, free cancellation until 10/22

Agent: Here is the booking. Shall I confirm it?
You:   Yes.
Agent: confirm_booking(token) → confirmed, reservation number TB-…
```

## Status

| Part | State |
| --- | --- |
| Search, filters, restaurant details, availability, area lookup | Tested against live tabelog.com |
| Sign-in, session reuse, history, HTTP mode, parallel-session lock | Tested |
| Booking steps after sign-in (plan choice, guest form, confirmation, completion) | **Written defensively, not yet run on a signed-in account.** Any page it does not recognize hands the booking to you instead of guessing. |

## Requirements

- **Node.js 20.10 or newer.** `npx` comes with it.
- **Google Chrome**, installed normally. Set `TABELOG_MCP_CHROME` to use another Chrome or Chromium binary.
- **A Tabelog account** (free). Tabelog signs in through LINE, Apple, Google, Yahoo! JAPAN, docomo, au, SoftBank, X, or a 価格.com ID.
- **A desktop session.** Tabelog's Japanese site blocks headless browsers, so the server runs a real Chrome window and parks it off-screen. It works on macOS, Windows, and Linux with a display. It does not work on a server without one.

## Install

The server is a command that your MCP client starts. Pick your client.

**Claude Code**

```bash
claude mcp add tabelog -- npx -y tabelog-mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.tabelog]
command = "npx"
args = ["-y", "tabelog-mcp"]
tool_timeout_sec = 120
```

**Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "tabelog": { "command": "npx", "args": ["-y", "tabelog-mcp"] }
  }
}
```

**From GitHub instead of npm**: replace `tabelog-mcp` with `github:ingrid-wu/tabelog-mcp` in any of the above. npm builds it on install. A private repository needs your GitHub access set up for git.

Then restart the client (or run `/mcp` in Claude Code) and ask: *"Check my Tabelog status."*

## First run: sign in once

Run this in a terminal, or ask the agent to call `tabelog_login`:

```bash
npx -y tabelog-mcp login
```

A Chrome window opens on Tabelog's login page. Sign in yourself. LINE (scan the QR code with your phone) and Apple are the quickest. Google, Yahoo! JAPAN, and 価格.com ID show a CAPTCHA or ask for a code. You type every password and code yourself; the server never sees them.

The window closes when Tabelog shows you as signed in. Later calls reuse the session. When the session expires, a tool returns `needs_login` and you sign in again.

## Tools

| Tool | What it does |
| --- | --- |
| `search_restaurants` | Area, keyword, date, time, party size, online-booking-only, private room, budget, sort (rating, trend, reviews, new). Each result lists the bookable times Tabelog shows around the searched time. |
| `find_area` | Tabelog's suggestions for a place name: stations, towns, areas. |
| `get_restaurant` | Tabelog's information table: genre, address, hours, closed days, budget, payment, receipts (invoice number), seats, private rooms, smoking, children, dress code. |
| `get_availability` | The booking calendar (open, few_left, full per day); the open party sizes for a date; the bookable times for a date and party. |
| `prepare_booking` | Step 1 of 2. Fills the booking form up to the final button and returns a summary plus a confirmation token. Books nothing. |
| `confirm_booking` | Step 2 of 2. Places the prepared booking. Marked destructive, so clients ask before running it. |
| `show_booking_window` | Shows the Chrome window with the current booking, so you can finish it by hand. |
| `tabelog_login`, `tabelog_status` | Sign in; check the data folder and sign-in state. |
| `get_booking_history`, `get_preferences`, `add_booking_note` | The booking memory (see below). |

Area and keyword are Japanese (銀座, 渋谷駅, 寿司, 焼肉). Agents translate English names before searching.

## How booking stays safe

```
prepare_booking ──> plan choice ──> guest form ──> confirmation page ──┐
                    (asks you if                                        │  stops here:
                     several plans)                                     │  summary + token
                                                                        ▼
            you read the summary and say yes in the chat
                                                                        │
confirm_booking(token) ──> token valid? page unchanged? ──> clicks the final button
                                                         ──> confirmed only if Tabelog's
                                                             completion page appears
```

- **Nothing is booked without a token.** `prepare_booking` never clicks a final button (予約を確定する and the like). `confirm_booking` needs a token from it, valid for 5 minutes and usable once.
- **The token is tied to what you saw.** If the confirmation page changed after prepare (time, party, price), confirm refuses with `SUMMARY_CHANGED`.
- **It never claims a booking it did not see.** If the page after the final click is not Tabelog's completion page, the result is `unclear` and the history records it as failed, so you can check Tabelog's reservation list.
- **Some steps are always yours.** Card entry, verification codes, and form fields it does not know return `needs_user` with the page. Call `show_booking_window` (the Chrome window comes on-screen at that step), or open the `handoff_url` in your own browser.
- **The agent must ask you first.** The server's instructions tell it to show the summary and wait for your yes. `confirm_booking` is marked destructive, so Claude Code and other clients ask for approval before it runs. Keep it out of your auto-approve list.
- **Narrow tools only.** No tool takes an arbitrary URL, script, or selector. Restaurant URLs must be canonical tabelog.com restaurant pages. Text on a web page cannot make the agent navigate anywhere else.
- **The browser loads only Tabelog.** While the server drives it, the browser blocks every host except tabelog.com, its image CDN, and Google's CAPTCHA service. Ads and trackers do not load. The block lifts only while the window is on-screen for you (sign-in providers need their own sites).

## What stays on your computer

Everything. Nothing goes to a server run by this project; there is none.

| Data | Where | What it is |
| --- | --- | --- |
| `profile/` | The data folder | The Chrome profile: Tabelog's session cookies, which are your sign-in. Not your password. |
| `history.jsonl` | The data folder | The booking memory |
| `http-token` | The data folder | Bearer token for HTTP mode |

The data folder is `~/Library/Application Support/tabelog-mcp` on macOS, `%APPDATA%\tabelog-mcp` on Windows, and `~/.local/share/tabelog-mcp` on Linux. Set `TABELOG_MCP_HOME` to move it. The folder is readable only by your user account. Delete it to sign out and forget everything.

Treat `profile/` like a password: anyone who copies it is signed in as you on Tabelog.

## Booking memory

Every booking attempt is saved, not just successes, with its purpose:

- **`purpose`**: `personal` or `business`. Required on `prepare_booking`; the agent asks when it is unclear.
- **What was booked**: restaurant, genre, area, score, date, time, party, plan, price, the confirmation summary, and the reservation number.
- **How it went**: `confirmed`, `handed_off` (with why: card, form field, …), `failed` (with why), or `abandoned` (prepared, never confirmed).
- **Notes**: what you tell the agent ("client dinner, needs a private room", "loved the counter, go back in spring"). Pass them as `notes` or with `add_booking_note` later.

The agent uses it in two ways:

- `get_preferences(purpose)` summarizes confirmed bookings into usual genres, areas, party size, time, and repeat restaurants, kept apart for personal and business. The server tells the agent to read it before suggesting places.
- `get_booking_history` returns the records with notes, so the agent can answer "where did I take the client last time?"

Export business bookings for expenses:

```bash
npx -y tabelog-mcp history --purpose business --csv > tabelog-business.csv
```

The history is an append-only JSON Lines file. Each line is one event, and several server processes can write to it at once.

## MCP server or harness: what lives where

A harness (Claude Code, Codex, Cursor, ChatGPT) runs the model: the agent loop, context management, memory files, skills, subagents, and permission prompts. An MCP server is one thing a harness plugs in: a process that offers tools. It has no model and no loop.

```
Harness (Claude Code / Codex / Cursor)
 ├─ model, agent loop, context, CLAUDE.md / AGENTS.md, skills, subagents, its own memory
 ├─ asks you before confirm_booking
 └─ MCP ──> tabelog-mcp (this repo, a process on your computer)
              ├─ tools: search, availability, prepare / confirm booking, history
              ├─ rules enforced in code: tokens, slot checks, URL allowlist
              ├─ Chrome with its own profile (your Tabelog session)
              └─ history.jsonl (booking memory)
```

- **In this server**: anything that must always be true (no booking without a token), anything that must work the same every time (finding buttons, parsing pages), and state that belongs to the domain and outlives any one chat (the Tabelog session, the booking history).
- **In the harness**: judgment. Which restaurant fits, when to ask you, how to phrase the summary, whether a dinner is personal or business.

So the booking memory lives in the MCP server, not in the harness. Any client you connect gets the same history. The harness's own memory (CLAUDE.md, a memory folder) is separate, and this server cannot read it.

## Several sessions at once

Chrome lets one process use a profile at a time. A second Claude Code session that starts its own copy of the server gets `BROWSER_BUSY` while the first one is using the browser. The browser closes after 10 idle minutes, which frees it.

If you run many sessions, run one shared server instead and point every client at it:

```bash
npx -y tabelog-mcp serve --http          # listens on http://127.0.0.1:3217/mcp
npx -y tabelog-mcp token                 # prints the bearer token
claude mcp add --transport http tabelog http://127.0.0.1:3217/mcp \
  --header "Authorization: Bearer $(npx -y tabelog-mcp token)"
```

HTTP mode listens on loopback only, requires the bearer token on every request, and rejects requests from web pages on other origins.

## ChatGPT

ChatGPT does not start local MCP servers. It connects over HTTPS to a server that is already running somewhere. To use this server from ChatGPT (custom connectors need a paid plan), run HTTP mode on your computer and expose it through a tunnel such as OpenAI's Secure MCP Tunnel, cloudflared, or ngrok. ChatGPT's servers then call your computer through the tunnel, and your session and history stay on your computer. This setup is **not tested yet**.

Hosting one shared copy of this server in the cloud does not work: Tabelog blocks headless and data-center browsers, and the host would hold every user's Tabelog session.

## Limits

- Tabelog has no public API. The server reads Tabelog's pages and the JSON its own pages use, so a Tabelog redesign can break it. Parsers live in `src/tabelog/parse.ts` and `src/booking/page.ts`, with page snapshots in `tests/fixtures/`.
- Japanese site only. The English site (tabelog.com/en) shows fewer open slots.
- Requests are paced to one every 1.5 s. A burst of use can still trigger Cloudflare (`BLOCKED`); wait a few minutes.
- Automated access and booking may conflict with Tabelog's terms of use. You use it with your own account, at your own risk. Use it for your own bookings at a personal pace.
- Cancelling or changing a booking is not supported. Do it on Tabelog.

## Troubleshooting

| Result | What to do |
| --- | --- |
| `needs_login` | Run `npx -y tabelog-mcp login` or ask the agent to call `tabelog_login`. |
| `needs_user` | Card, code, or an unknown form field. Call `show_booking_window` and finish in the window, or open `handoff_url`. |
| `choose_plan` | Pick a plan from the list; call `prepare_booking` again with `plan`. |
| `BLOCKED` | Cloudflare refused the request. Wait a few minutes. |
| `BROWSER_BUSY` | Another session holds the browser. Close it, or use HTTP mode. |
| `CHROME_NOT_FOUND` | Install Google Chrome, or set `TABELOG_MCP_CHROME`. |
| `AREA_NOT_FOUND` | Use a Japanese place name, or `find_area`. |
| `SLOT_UNAVAILABLE` | `error.details.open_times` lists what is open. |
| `TOKEN_INVALID`, `SUMMARY_CHANGED` | Call `prepare_booking` again and show the new summary. |
| `PAGE_CHANGED` | Tabelog changed a page. Open an issue with the tool name. |

## Development

```bash
npm install
npm run check     # type check and tests (parsers against real page snapshots, booking safety rules, the MCP surface)
npm run build     # compiles to dist/
node dist/cli.js --help
```

The tests never touch tabelog.com. `tests/booking-service.test.ts` drives the booking flow with a scripted browser and checks the safety rules: no final click while preparing, single-use and expiring tokens, refusal when the page changed, and no success without a completion page.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Tabelog or Kakaku.com, Inc.
