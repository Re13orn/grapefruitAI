import ObjC from "frida-objc-bridge";
import { performOnMainThread } from "@/fruity/lib/dispatch.js";

type Point = [number, number];

interface BasicResult {
  ok: boolean;
  strategy: string;
  detail?: string;
}

function keyWindow() {
  const app = ObjC.classes.UIApplication.sharedApplication();

  if (typeof app.keyWindow === "function") {
    const win = app.keyWindow();
    if (win && !win.isNull?.()) return win;
  }

  if (typeof app.windows === "function") {
    const windows = app.windows();
    if (windows && windows.count) {
      const count = Number(windows.count().valueOf());
      for (let i = 0; i < count; i++) {
        const win = windows.objectAtIndex_(i);
        if (win && typeof win.isKeyWindow === "function" && win.isKeyWindow()) {
          return win;
        }
      }
      if (count > 0) {
        return windows.objectAtIndex_(count - 1);
      }
    }
  }

  return null;
}

function hitView(point: Point) {
  const win = keyWindow();
  if (!win) return null;
  if (typeof win.hitTest_withEvent_ !== "function") return null;
  return win.hitTest_withEvent_(point, NULL);
}

function findFirstResponder(view: ObjC.Object | null): ObjC.Object | null {
  if (!view) return null;
  if (typeof view.isFirstResponder === "function" && view.isFirstResponder()) {
    return view;
  }

  if (typeof view.subviews !== "function") return null;
  const subviews = view.subviews();
  if (!subviews || typeof subviews.count !== "function") return null;

  const count = Number(subviews.count().valueOf());
  for (let i = 0; i < count; i++) {
    const child = subviews.objectAtIndex_(i) as ObjC.Object;
    const found = findFirstResponder(child);
    if (found) return found;
  }
  return null;
}

function topViewController() {
  const win = keyWindow();
  if (!win || typeof win.rootViewController !== "function") return null;

  let current = win.rootViewController() as ObjC.Object | null;
  if (!current) return null;

  let guard = 0;
  while (guard++ < 16) {
    if (
      typeof current.presentedViewController === "function" &&
      current.presentedViewController()
    ) {
      current = current.presentedViewController() as ObjC.Object;
      continue;
    }

    if (
      typeof current.visibleViewController === "function" &&
      current.visibleViewController()
    ) {
      current = current.visibleViewController() as ObjC.Object;
      continue;
    }
    break;
  }

  return current;
}

function findScrollableAncestor(view: ObjC.Object | null) {
  let cur = view;
  let guard = 0;
  while (cur && guard++ < 24) {
    if (
      typeof cur.setContentOffset_animated_ === "function" &&
      typeof cur.contentOffset === "function"
    ) {
      return cur;
    }
    if (typeof cur.superview !== "function") break;
    cur = cur.superview() as ObjC.Object | null;
  }
  return null;
}

export async function tap(x: number, y: number): Promise<BasicResult> {
  return await performOnMainThread(() => {
    const view = hitView([x, y]);
    if (!view) {
      throw new Error(`No view found at point (${x}, ${y})`);
    }

    if (typeof view.sendActionsForControlEvents_ === "function") {
      view.sendActionsForControlEvents_(1 << 6);
      return { ok: true, strategy: "ui_control_event" };
    }

    if (typeof view.becomeFirstResponder === "function") {
      view.becomeFirstResponder();
      return { ok: true, strategy: "become_first_responder" };
    }

    return {
      ok: false,
      strategy: "best_effort",
      detail: "target view is not a UIControl and cannot receive synthetic tap event",
    };
  });
}

export async function inputText(text: string): Promise<BasicResult> {
  return await performOnMainThread(() => {
    const win = keyWindow();
    const responder = findFirstResponder(win as ObjC.Object | null);
    if (!responder) {
      throw new Error("No active first responder found for text input");
    }

    if (typeof responder.insertText_ === "function") {
      responder.insertText_(text);
      return { ok: true, strategy: "insert_text" };
    }

    if (typeof responder.setText_ === "function") {
      responder.setText_(text);
      if (typeof responder.sendActionsForControlEvents_ === "function") {
        responder.sendActionsForControlEvents_(1 << 17);
      }
      return { ok: true, strategy: "set_text" };
    }

    throw new Error(
      `First responder ${responder.$className} does not support text input`,
    );
  });
}

export async function swipe(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<BasicResult> {
  return await performOnMainThread(() => {
    const view = hitView([x1, y1]);
    const scrollable = findScrollableAncestor(view);
    if (!scrollable) {
      throw new Error("No scrollable view found at swipe start point");
    }

    const offset = scrollable.contentOffset();
    const nextX = Number(offset.x) + (x1 - x2);
    const nextY = Number(offset.y) + (y1 - y2);
    scrollable.setContentOffset_animated_([nextX, nextY], true);

    return { ok: true, strategy: "scrollview_offset" };
  });
}

export async function back(): Promise<BasicResult> {
  return await performOnMainThread(() => {
    const top = topViewController();
    if (!top) throw new Error("Unable to resolve current view controller");

    const nav =
      typeof top.navigationController === "function"
        ? (top.navigationController() as ObjC.Object | null)
        : null;

    if (
      nav &&
      typeof nav.viewControllers === "function" &&
      nav.viewControllers().count().valueOf() > 1 &&
      typeof nav.popViewControllerAnimated_ === "function"
    ) {
      nav.popViewControllerAnimated_(true);
      return { ok: true, strategy: "navigation_pop" };
    }

    if (
      typeof top.presentingViewController === "function" &&
      top.presentingViewController() &&
      typeof top.dismissViewControllerAnimated_completion_ === "function"
    ) {
      top.dismissViewControllerAnimated_completion_(true, NULL);
      return { ok: true, strategy: "dismiss_presented" };
    }

    throw new Error("No available in-app back action");
  });
}

export async function home(): Promise<BasicResult> {
  return await performOnMainThread(() => {
    const app = ObjC.classes.UIApplication.sharedApplication();
    if (
      typeof app.respondsToSelector_ === "function" &&
      app.respondsToSelector_(ObjC.selector("suspend"))
    ) {
      app.performSelector_(ObjC.selector("suspend"));
      return { ok: true, strategy: "application_suspend" };
    }

    throw new Error("Home action is unavailable on this target");
  });
}
