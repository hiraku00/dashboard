import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { VideoEditor, blankVideo } from "@/app/text-tube-app";

// Replaces tests/rendered-html.test.mjs's "closes the TextTube editor when
// its backdrop is clicked" (Issue #94). That test only grepped
// app/text-tube-app.tsx's source for the backdrop's className/onClick/
// stopPropagation wiring -- it never actually rendered the component or
// clicked anything. This does, with @testing-library/react (see
// vitest.config.ts's "dom" project, environment: "jsdom").

afterEach(() => {
  cleanup();
});

function renderEditor(onClose: () => void) {
  render(
    <VideoEditor
      title="動画を編集"
      value={blankVideo}
      onChange={() => {}}
      onClose={onClose}
      onSubmit={(event) => event.preventDefault()}
      submitLabel="保存する"
    />,
  );
}

test("clicking the backdrop closes the editor", () => {
  const onClose = vi.fn();
  renderEditor(onClose);
  // role="presentation" (the backdrop) is deliberately not exposed as an
  // accessible "button" or similar -- it is the outer div itself.
  fireEvent.click(screen.getByRole("presentation"));
  expect(onClose).toHaveBeenCalledOnce();
});

test("clicking inside the dialog does not close the editor", () => {
  const onClose = vi.fn();
  renderEditor(onClose);
  // The dialog's own onClick calls stopPropagation() specifically so a
  // click landing on its content (not the backdrop) does not bubble up to
  // the backdrop's onClose -- clicking the heading is a click that reaches
  // the dialog but not any of its own interactive controls.
  fireEvent.click(screen.getByRole("heading", { name: "動画を編集" }));
  expect(onClose).not.toHaveBeenCalled();
});

test("clicking the × button closes the editor", () => {
  const onClose = vi.fn();
  renderEditor(onClose);
  fireEvent.click(screen.getByRole("button", { name: "×" }));
  expect(onClose).toHaveBeenCalledOnce();
});
