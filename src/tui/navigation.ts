/**
 * Navigation state machine, screen discriminated union, and stack reducer for Model Control Center TUI.
 */

export type DetailTab = "overview" | "benchmarks" | "pricing" | "subscription";

export const DETAIL_TABS: readonly DetailTab[] = [
  "overview",
  "benchmarks",
  "pricing",
  "subscription",
] as const;

export type MenuOption = "models" | "quarantines";

export const MENU_OPTIONS: readonly MenuOption[] = ["models", "quarantines"] as const;

export type ScreenState =
  | { name: "main-menu"; selectedIndex: number }
  | { name: "providers" }
  | { name: "models"; providerId: string }
  | { name: "model-detail"; providerId: string; modelId: string; tab: DetailTab }
  | { name: "quarantines" };

export type NavigationEvent =
  | { type: "up" }
  | { type: "down" }
  | { type: "activate" }
  | { type: "back" }
  | { type: "tab-next" }
  | { type: "tab-prev" };

export function createInitialStack(): ScreenState[] {
  return [{ name: "main-menu", selectedIndex: 0 }];
}

export function transitionScreen(screen: ScreenState, event: NavigationEvent): ScreenState {
  switch (event.type) {
    case "up": {
      if (screen.name === "main-menu") {
        const nextIndex =
          (screen.selectedIndex - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        return { name: "main-menu", selectedIndex: nextIndex };
      }
      return screen;
    }

    case "down": {
      if (screen.name === "main-menu") {
        const nextIndex = (screen.selectedIndex + 1) % MENU_OPTIONS.length;
        return { name: "main-menu", selectedIndex: nextIndex };
      }
      return screen;
    }

    case "tab-next": {
      if (screen.name === "model-detail") {
        const currentIdx = DETAIL_TABS.indexOf(screen.tab);
        const nextIdx = (currentIdx + 1) % DETAIL_TABS.length;
        const nextTab = DETAIL_TABS[nextIdx] ?? "overview";
        return { ...screen, tab: nextTab };
      }
      return screen;
    }

    case "tab-prev": {
      if (screen.name === "model-detail") {
        const currentIdx = DETAIL_TABS.indexOf(screen.tab);
        const prevIdx = (currentIdx - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
        const prevTab = DETAIL_TABS[prevIdx] ?? "overview";
        return { ...screen, tab: prevTab };
      }
      return screen;
    }

    default:
      return screen;
  }
}

export function pushScreen(stack: ScreenState[], screen: ScreenState): ScreenState[] {
  return [...stack, screen];
}

export function popScreen(stack: ScreenState[]): { stack: ScreenState[]; exited: boolean } {
  if (stack.length <= 1) {
    return { stack: [], exited: true };
  }
  return { stack: stack.slice(0, -1), exited: false };
}

export function handleNavigation(
  stack: ScreenState[],
  event: NavigationEvent
): { stack: ScreenState[]; exited: boolean } {
  if (stack.length === 0) {
    return { stack: [], exited: true };
  }

  const currentScreen = stack[stack.length - 1];
  if (!currentScreen) {
    return { stack: [], exited: true };
  }

  if (event.type === "back") {
    return popScreen(stack);
  }

  if (event.type === "activate") {
    if (currentScreen.name === "main-menu") {
      const selectedOption = MENU_OPTIONS[currentScreen.selectedIndex];
      if (selectedOption === "models") {
        return { stack: pushScreen(stack, { name: "providers" }), exited: false };
      }
      if (selectedOption === "quarantines") {
        return { stack: pushScreen(stack, { name: "quarantines" }), exited: false };
      }
    }
    return { stack, exited: false };
  }

  const updatedScreen = transitionScreen(currentScreen, event);
  const updatedStack = [...stack.slice(0, -1), updatedScreen];
  return { stack: updatedStack, exited: false };
}
