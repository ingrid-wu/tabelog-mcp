# tabelog-mcp

An MCP server that finds and books restaurants in Japan on [Tabelog (食べログ)](https://tabelog.com) for Claude, Codex, Cursor, or any MCP client. It is built for business dinners: a private room for the whole party, near everyone's office, on the next free evening. It drives a real Chrome on your own computer, signed in to your own Tabelog account, and keeps a local memory of your preferences and bookings.

![tabelog-mcp demo: an agent calls find_available_restaurants for a private room for 7 within 15 minutes of 有楽町 and 新橋 over the next 3 days; the server fills the dinner window and private room from preferences, checks 30 candidates, and lists 5 restaurants with a room for 7, walking minutes to both stations, and open dinner times](docs/demo.gif)

```
You: Find a restaurant with a private room for 7 people within 15 minutes of 有楽町 and 新橋,
     in the next 3 days, for dinner.

Agent: find_available_restaurants(locations: [有楽町, 新橋], party: 7)
       defaults from preferences: 2026-10-23..25, 17:00-20:00, private room, 15 min walk

       → 30 candidates, 20 within walking range of both, 5 with a room for 7 and open times:
         赤坂璃宮 銀座店        3.74  中華   有楽町 6 min · 新橋 12 min   10/23 17:30-20:00, 10/24 …, 10/25 …
         焼肉うしごろ 並木通り店 3.68  焼肉   有楽町 6 min · 新橋 15 min   10/23 17:00 17:30, 10/24 …
         鮨 冨味               3.66  寿司   有楽町 10 min · 新橋 10 min  10/24 17:00-20:00
         …

You:   Book 鮨 冨味 on the 24th at 19:00. We usually start at 7, by the way.

Agent: set_preferences(dinner_from: 18:30, dinner_to: 20:30)
       prepare_booking(鮨 冨味, 2026-10-24, 19:00, party: 7, plan: 個室)
       → (first time: a Chrome window opens; you sign in with LINE or Apple; it carries on)
       → ready: summary + confirmation token

Agent: Here is the booking: … Shall I confirm it?
You:   Yes.
Agent: confirm_booking(token) → confirmed
```

The search results above are real output from a run on 2026-10-22. The booking half shows the flow; see Status.

## Status

| Part | State |
| --- | --- |
| `find_available_restaurants`, search, filters, restaurant details, availability, area lookup | Tested against live tabelog.com |
| History, preferences, HTTP mode, parallel-session lock, background Chrome on macOS | Tested |
| Sign-in and the booking steps after it (plan choice, guest form, confirmation, completion) | **Tested only against a scripted browser, not yet a signed-in account.** Any page the server does not recognize hands the booking to you instead of guessing. |

## Requirements

- **Node.js 20.10 or newer.** `npx` comes with it.
- **Google Chrome**, installed normally. Set `TABELOG_MCP_CHROME` to use another Chrome or Chromium binary.
- **A Tabelog account** (free). Tabelog signs in through LINE, Apple, Google, Yahoo! JAPAN, docomo, au, SoftBank, X, or a 価格.com ID.
- **A desktop session.** Tabelog's Japanese site blocks headless browsers, so the server runs a real Chrome window and parks it off-screen. On macOS it starts Chrome in the background, so it never takes focus or switches your desktop; the window comes forward only for sign-in or a handoff. It works on macOS, Windows, and Linux with a display. It does not work on a server without one.

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
tool_timeout_sec = 330
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

Then restart the client (or run `/mcp` in Claude Code) and ask for a dinner.

`find_available_restaurants` can take up to 2 minutes, and a booking can wait up to 3 minutes for you to sign in. The server sends progress messages while it works. If your client still gives up early, raise its tool timeout: `tool_timeout_sec` above for Codex, or the `MCP_TOOL_TIMEOUT` environment variable (milliseconds) for Claude Code.

## Signing in

There is no separate setup step. The first time a booking needs your account, `prepare_booking` opens a Chrome window on Tabelog's login page, waits while you sign in, and then carries on with the same booking. Searching and checking availability never need an account.

- **How to sign in:** LINE (scan the QR code with your phone) and Apple are the quickest. Google, Yahoo! JAPAN, and 価格.com ID show a CAPTCHA or ask for a code. You type every password and code yourself; the server never sees them.
- **If you take longer than 3 minutes**, the booking returns `needs_login` and the window stays open. Finish signing in, then ask again.
- **How long it lasts:** Tabelog does not publish how long a sign-in lasts, and it can end it early (for example when you change your password). When you sign in, the server reads the expiry date of the session cookie Tabelog sets, and `tabelog_status` shows it as `session_expires_at`. Until that date, every call reuses the session with no window. After it, the next booking opens the sign-in window again.
- **Where it lives:** in the server's own Chrome profile on your computer (see below), not in your everyday Chrome, and never in this repository.

To sign in ahead of time instead, run `npx -y tabelog-mcp login`.

## Tools

| Tool | What it does |
| --- | --- |
| `find_available_restaurants` | The main search. One to four locations, walking limit, party size, the next N days (or exact dates), a seating window, private room, cuisine, budget. Returns restaurants within walking range of every location, whether a private room fits the party, and every open time in the window. Unset options come from your preferences. Takes 30 s to 2 min (faster once locations are cached). |
| `set_preferences`, `get_preferences` | What you have told the agent (seating windows, usual party, private room, walking limit, budget, notes), and what your past bookings show. |
| `search_restaurants` | Area, keyword, date, time, party size, online-booking-only, private room, budget, sort (rating, trend, reviews, new). Each result lists the bookable times Tabelog shows around the searched time. |
| `find_area` | Tabelog's suggestions for a place name: stations, towns, areas. |
| `get_restaurant` | Tabelog's information table: genre, address, hours, closed days, budget, payment, receipts (invoice number), seats, private rooms, smoking, children, dress code. |
| `get_availability` | The booking calendar (open, few_left, full per day); the open party sizes for a date; the bookable times for a date and party. |
| `prepare_booking` | Step 1 of 2. Fills the booking form up to the final button and returns a summary plus a confirmation token. Books nothing. |
| `confirm_booking` | Step 2 of 2. Places the prepared booking. Marked destructive, so clients ask before running it. |
| `show_booking_window` | Shows the Chrome window with the current booking, so you can finish it by hand. |
| `tabelog_status`, `tabelog_login` | Sign-in state and expiry, data folder; optional early sign-in. |
| `get_booking_history`, `add_booking_note` | The booking memory (see below). |

Locations and keywords are Japanese (有楽町, 渋谷駅, 寿司, 焼肉). Agents translate English names before calling. Stations work best, because Tabelog gives their coordinates; `"lat,lng"` works too, alongside at least one named place.

## How the business search works

```
locations ──> Tabelog's station coordinates
      │
      ▼
for each location × each day: Tabelog search (online booking open, party, private room, budget)
      │  up to 30 top-rated candidates
      ▼
walking time from every location, from each restaurant's map pin   (cached for 30 days)
      │  keep those within the limit for all locations
      ▼
private room: does Tabelog's 個室 row list a room for the party? (6人可, 10～20人可 …)
      │
      ▼
real open times for the party on each day, inside the seating window
```

- **Walking time is an estimate:** straight-line distance × 1.25 for streets, at 80 m per minute (the speed Japanese listings use). It is not transit; Tabelog has no routing.
- **Private room** means Tabelog lists a room that fits the party. Which room you get is decided when booking: pick the 個室 plan or seat, or the restaurant assigns it.
- **Defaults** (when the request does not say): business purpose, the next 3 days, dinner 17:00 to 20:00, lunch 11:30 to 13:30, private room for business, 15 minutes' walk.

## Preferences

Tell the agent how you like to book and it saves that with `set_preferences`; later searches use it as the default.

- "We usually start at 7" saves a dinner window of 18:30 to 20:30.
- "It's normally 6 of us" saves a usual party of 6.
- "Clients are fine with a 10-minute walk" saves a 10-minute limit.
- "Avoid 焼肉 for this client" saves a note the agent reads before suggesting.

Business and personal keep separate preferences. Business is the default purpose. Anything you say in a request ("at 7:30 this time") overrides the saved default for that request only.

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
- **The browser loads only Tabelog.** While the server drives it, the browser blocks every host except tabelog.com, its image CDN, Cloudflare's visitor check, and Google's CAPTCHA service. Ads and trackers do not load. The block lifts only while the window is on-screen for you (sign-in providers need their own sites).

## What stays on your computer

Everything. Nothing goes to a server run by this project; there is none.

| Data | Where | What it is |
| --- | --- | --- |
| `profile/` | The data folder | The Chrome profile: Tabelog's session cookies, which are your sign-in. Not your password. |
| `session.json` | The data folder | When you signed in and when the session cookie expires |
| `preferences.json` | The data folder | What you told the agent |
| `history.jsonl` | The data folder | The booking memory |
| `places.json` | The data folder | Restaurant map pins and room info, cached for 30 days |
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

On macOS the server controls its Chrome through a DevTools port on 127.0.0.1 (a random port, open only while that Chrome runs). Other programs running as you on the same computer could reach that port; nothing off the computer can.

## ChatGPT

ChatGPT does not start local MCP servers. It connects over HTTPS to a server that is already running somewhere. To use this server from ChatGPT (custom connectors need a paid plan), run HTTP mode on your computer and expose it through a tunnel such as OpenAI's Secure MCP Tunnel, cloudflared, or ngrok. ChatGPT's servers then call your computer through the tunnel, and your session and history stay on your computer. This setup is **not tested yet**.

Hosting one shared copy of this server in the cloud does not work: Tabelog blocks headless and data-center browsers, and the host would hold every user's Tabelog session.

## Limits

- Tabelog has no public API. The server reads Tabelog's pages and the JSON its own pages use, so a Tabelog redesign can break it. Parsers live in `src/tabelog/parse.ts` and `src/booking/page.ts`, with page snapshots in `tests/fixtures/`.
- Japanese site only. The English site (tabelog.com/en) shows fewer open slots.
- Requests are paced to one every 1.5 s. Cloudflare sometimes shows new visitors a "しばらくお待ちください" check; the browser passes it on its own and the server waits up to 20 s. Heavy use can still get a temporary `BLOCKED`; in testing it cleared within about 5 minutes.
- Automated access and booking may conflict with Tabelog's terms of use. You use it with your own account, at your own risk. Use it for your own bookings at a personal pace.
- Cancelling or changing a booking is not supported. Do it on Tabelog.

## Troubleshooting

| Result | What to do |
| --- | --- |
| `needs_login` | The sign-in window is open and waiting. Sign in there, then ask again. |
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
