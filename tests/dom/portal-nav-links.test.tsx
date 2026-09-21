import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { PortalNavLinks } from "@/app/portal-nav-links";

// The nav marks a clicked tab as pending (a highlighted link and a bar along
// the top) until the next page arrives, so a click is acknowledged while the
// server is still reading D1. It must NOT touch anything server-rendered; these
// tests cover only the client behaviour.

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
// The real <Link> needs the app router; a plain anchor keeps its onClick contract.
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, className }: { href: string; children: ReactNode; onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void; className?: string; prefetch?: boolean }) => (
    <a href={href} className={className} onClick={(event) => { onClick?.(event); event.preventDefault(); }}>{children}</a>
  ),
}));

const links = [["/", "ホーム"], ["/watch-list", "Watch List"], ["/todo", "To Do"]] as const;
const renderNav = (active = "/") => render(<PortalNavLinks links={links} active={active} />);
const progress = () => document.querySelector(".nav-progress");

beforeEach(() => { pathname = "/"; });
afterEach(() => { cleanup(); vi.useRealTimers(); });

test("a click on another tab marks it pending and shows the progress bar", () => {
  renderNav();
  expect(progress()).toBeNull();
  fireEvent.click(screen.getByText("To Do"));
  expect(screen.getByText("To Do").className).toContain("pending");
  expect(progress()).not.toBeNull();
  expect(screen.getByRole("status").textContent).toBe("読み込み中");
  // Only the clicked one.
  expect(screen.getByText("Watch List").className).not.toContain("pending");
});

test("keeps the active tab's highlight and adds nothing else to it", () => {
  renderNav("/");
  expect(screen.getByText("ホーム").className).toBe("active");
  expect(screen.getByText("Watch List").className).toBe("");
});

test("a click on the tab you are already on is not a navigation", () => {
  renderNav("/");
  fireEvent.click(screen.getByText("ホーム"));
  expect(progress()).toBeNull();
  expect(screen.getByText("ホーム").className).not.toContain("pending");
});

test.each([
  ["ctrl", { ctrlKey: true }],
  ["cmd", { metaKey: true }],
  ["shift", { shiftKey: true }],
  ["alt", { altKey: true }],
  ["middle button", { button: 1 }],
])("%s-click opens elsewhere, so nothing is pending here", (_name, init) => {
  renderNav();
  fireEvent.click(screen.getByText("To Do"), init);
  expect(progress()).toBeNull();
  expect(screen.getByText("To Do").className).not.toContain("pending");
});

test("the pending state ends when the pathname changes", () => {
  const view = renderNav();
  fireEvent.click(screen.getByText("To Do"));
  expect(progress()).not.toBeNull();
  pathname = "/todo"; // the page the click was waiting for arrived
  view.rerender(<PortalNavLinks links={links} active="/todo" />);
  expect(progress()).toBeNull();
  expect(screen.getByText("To Do").className).toBe("active");
  expect(screen.getByRole("status").textContent).toBe("");
});

test("gives up after 20 seconds so a navigation that never lands cannot leave the bar running", () => {
  vi.useFakeTimers();
  renderNav();
  fireEvent.click(screen.getByText("To Do"));
  expect(progress()).not.toBeNull();
  act(() => { vi.advanceTimersByTime(19_000); });
  expect(progress()).not.toBeNull();
  act(() => { vi.advanceTimersByTime(1_500); });
  expect(progress()).toBeNull();
});

test("a second click moves the pending mark to the new tab", () => {
  renderNav();
  fireEvent.click(screen.getByText("To Do"));
  fireEvent.click(screen.getByText("Watch List"));
  expect(screen.getByText("Watch List").className).toContain("pending");
  expect(screen.getByText("To Do").className).not.toContain("pending");
});

test("renders every link with its href", () => {
  renderNav();
  expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/", "/watch-list", "/todo"]);
});
