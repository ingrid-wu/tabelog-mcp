// Classifies one page of Tabelog's booking flow. Pure: it reads a snapshot of
// the page and returns what kind of step it is. The flow after login is not yet
// verified against a signed-in account, so every rule here is conservative:
// anything it does not recognize becomes "unknown", which hands the booking to
// the user instead of guessing.

import { type HTMLElement, parse } from "node-html-parser";

const text = (element: HTMLElement | null | undefined): string =>
  (element?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Buttons that place the booking. Never clicked while preparing. */
export const finalButtonPattern = /予約を確定|予約確定|この内容で予約|予約する$|申し込む|申込を確定|予約を完了/;

/** Buttons that only move to the next step of the form. */
export const nextButtonPattern = /^(次へ|次に進む|確認画面へ|入力内容を確認|内容を確認する|確認へ進む|予約内容の確認へ|予約内容を確認)/;

const planButtonPattern = /^(選択する|選択|このプランを選択|このコースを選択|このコースで予約|このプランで予約|席のみ予約)/;

const completePattern = /予約が完了|予約を受け付けました|予約が確定しました|ご予約ありがとうございます/;

export interface ButtonRef {
  /** Visible text, used to find the same control in the live page. */
  readonly text: string;
  /** Which of the controls with this exact text, in document order. */
  readonly occurrence: number;
}

const controlSelector = "button, a, input[type=submit], input[type=button]";

function controlText(element: HTMLElement): string {
  return element.tagName === "INPUT" ? (element.getAttribute("value") ?? "").trim() : text(element);
}

/** Every control in document order, with its occurrence index among same-text controls. */
function controls(root: HTMLElement): { element: HTMLElement; ref: ButtonRef }[] {
  const seen = new Map<string, number>();
  return root.querySelectorAll(controlSelector).flatMap((element) => {
    const label = controlText(element);
    if (!label || label.length > 30) return [];
    const occurrence = seen.get(label) ?? 0;
    seen.set(label, occurrence + 1);
    return [{ element, ref: { text: label, occurrence } }];
  });
}

export interface PlanOption {
  readonly label: string;
  readonly price: string | null;
  readonly button: ButtonRef;
}

export interface BookingSummary {
  /** Label/value pairs from the confirmation page, in page order. */
  readonly fields: Readonly<Record<string, string>>;
  /** The page's main text, bounded, for anything the pairs miss. */
  readonly excerpt: string;
}

export type BookingPage =
  | { readonly kind: "login_required" }
  | { readonly kind: "choose_plan"; readonly plans: readonly PlanOption[] }
  | { readonly kind: "card_required" }
  | { readonly kind: "form"; readonly missing: readonly string[]; readonly next: ButtonRef | null }
  | { readonly kind: "confirm"; readonly summary: BookingSummary; readonly confirm: ButtonRef }
  | { readonly kind: "complete"; readonly reservationNumber: string | null; readonly excerpt: string }
  | { readonly kind: "unknown"; readonly title: string };

export interface PageSnapshot {
  readonly url: string;
  readonly html: string;
  /** Labels of required inputs that are empty in the live page (values set by script are not in the HTML). */
  readonly missingRequired: readonly string[];
}

function hasCardEntry(root: HTMLElement, body: string): boolean {
  if (root.querySelector('input[autocomplete="cc-number"], input[name*="card_number"], input[name*="cardno"], input[name*="card_no"]')) {
    return true;
  }
  if (root.querySelectorAll("iframe").some((frame) => /veritrans|gmo-pg|paygent|stripe|sbpayment|payment/i.test(frame.getAttribute("src") ?? ""))) {
    return true;
  }
  return /カード番号|セキュリティコード/.test(body);
}

function labeledPairs(root: HTMLElement): Record<string, string> {
  const fields: Record<string, string> = {};
  const add = (label: string, value: string): void => {
    if (label && value && label.length <= 30 && !(label in fields)) fields[label] = value.slice(0, 300);
  };
  for (const row of root.querySelectorAll("tr")) add(text(row.querySelector("th")), text(row.querySelector("td")));
  for (const term of root.querySelectorAll("dt")) {
    const definition = term.nextElementSibling;
    if (definition?.tagName === "DD") add(text(term), text(definition));
  }
  return fields;
}

function planOptions(root: HTMLElement): PlanOption[] {
  const plans: PlanOption[] = [];
  for (const { element, ref } of controls(root)) {
    const label = ref.text;
    if (!planButtonPattern.test(label)) continue;
    // The plan's name and price sit in the nearest container above its button.
    let container: HTMLElement | null = element.parentNode;
    for (let depth = 0; depth < 6 && container && !/[\d,]+\s*円/.test(text(container)) && label !== "席のみ予約"; depth += 1) {
      container = container.parentNode;
    }
    const heading = container?.querySelector("h2, h3, h4, [class*=title], [class*=name]");
    const containerText = text(container);
    const price = /([\d,]+)\s*円/.exec(containerText)?.[0] ?? null;
    plans.push({
      label: label === "席のみ予約" ? "席のみ予約" : text(heading) || containerText.slice(0, 60),
      price,
      button: ref,
    });
  }
  return plans;
}

export function readBookingPage(snapshot: PageSnapshot): BookingPage {
  const root = parse(snapshot.html);
  const main = root.querySelector("main") ?? root.querySelector("body") ?? root;
  const body = text(main);
  const title = text(root.querySelector("title"));

  if (/\/booking\/no_login\/|\/account\/login/.test(snapshot.url) || body.includes("ご利用にはログインが必要です")) {
    return { kind: "login_required" };
  }
  if (completePattern.test(body)) {
    const reservationNumber = /予約番号[\s:：]*([A-Za-z0-9-]{4,})/.exec(body)?.[1] ?? null;
    return { kind: "complete", reservationNumber, excerpt: body.slice(0, 1_500) };
  }
  if (hasCardEntry(root, body)) return { kind: "card_required" };

  const plans = planOptions(main);
  if (plans.length > 0) return { kind: "choose_plan", plans };

  const refs = controls(main).map((control) => control.ref);
  const finals = refs.filter((button) => finalButtonPattern.test(button.text));
  const next = refs.find((button) => nextButtonPattern.test(button.text) && !finalButtonPattern.test(button.text)) ?? null;
  // Exactly one final control, or the page is not a confirmation page this parser understands.
  const final = finals.length === 1 ? finals[0] : undefined;
  if (final && !next && snapshot.missingRequired.length === 0) {
    return { kind: "confirm", summary: { fields: labeledPairs(main), excerpt: body.slice(0, 2_000) }, confirm: final };
  }
  if (next || snapshot.missingRequired.length > 0) {
    return { kind: "form", missing: snapshot.missingRequired, next };
  }
  return { kind: "unknown", title };
}

/** Japanese renderings of a date that a confirmation page could use. */
export function dateRenderings(date: string): string[] {
  const [year, month, day] = date.split("-").map(Number);
  return [
    `${year}年${month}月${day}日`,
    `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
    `${year}/${month}/${day}`,
    `${month}月${day}日`,
  ];
}

/** True when the summary visibly names the requested date, time, and party size. */
export function summaryMatchesRequest(
  summary: BookingSummary,
  request: { readonly date: string; readonly time: string; readonly party: number },
): boolean {
  const all = `${Object.values(summary.fields).join(" ")} ${summary.excerpt}`;
  const time = request.time.replace(/^0/, "");
  return (
    dateRenderings(request.date).some((rendering) => all.includes(rendering)) &&
    (all.includes(request.time) || all.includes(time)) &&
    new RegExp(`(^|[^\\d])${request.party}\\s*名`).test(all)
  );
}
