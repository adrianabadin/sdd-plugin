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
  | { name: "providers"; selectedIndex: number }
  | {
      name: "models";
      providerId: string;
      selectedIndex: number;
      query: string;
      searchActive: boolean;
    }
  | {
      name: "model-detail";
      providerId: string;
      modelId: string;
      tab: DetailTab;
      focus?: { area: "tabs" } | { area: "fields"; index: number };
    }
  | { name: "quarantines" };

export type NavigationEvent =
  | { type: "up" }
  | { type: "down" }
  | { type: "activate" }
  | { type: "back" }
  | { type: "tab-next" }
  | { type: "tab-prev" }
  | { type: "search-start" }
  | { type: "search-stop" }
  | { type: "search-input"; query: string }
  | { type: "field-next" }
  | { type: "field-prev" }
  | { type: "focus-fields"; index?: number }
  | { type: "focus-tabs" }
  | { type: "save-intent" }
  | { type: "discard-draft" };

export function createInitialStack(): ScreenState[] {
  return [{ name: "main-menu", selectedIndex: 0 }];
}

export function transitionScreen(
  screen: ScreenState,
  event: NavigationEvent,
  maxIndex: number = 0
): ScreenState {
  switch (event.type) {
    case "up": {
      if (screen.name === "main-menu") {
        const nextIndex =
          (screen.selectedIndex - 1 + MENU_OPTIONS.length) % MENU_OPTIONS.length;
        return { name: "main-menu", selectedIndex: nextIndex };
      }
      if (screen.name === "providers") {
        const total = maxIndex > 0 ? maxIndex : 1;
        const nextIndex = (screen.selectedIndex - 1 + total) % total;
        return { name: "providers", selectedIndex: nextIndex };
      }
      if (screen.name === "models") {
        const total = maxIndex > 0 ? maxIndex : 1;
        const nextIndex = (screen.selectedIndex - 1 + total) % total;
        return { ...screen, selectedIndex: nextIndex };
      }
      return screen;
    }

    case "down": {
      if (screen.name === "main-menu") {
        const nextIndex = (screen.selectedIndex + 1) % MENU_OPTIONS.length;
        return { name: "main-menu", selectedIndex: nextIndex };
      }
      if (screen.name === "providers") {
        const total = maxIndex > 0 ? maxIndex : 1;
        const nextIndex = (screen.selectedIndex + 1) % total;
        return { name: "providers", selectedIndex: nextIndex };
      }
      if (screen.name === "models") {
        const total = maxIndex > 0 ? maxIndex : 1;
        const nextIndex = (screen.selectedIndex + 1) % total;
        return { ...screen, selectedIndex: nextIndex };
      }
      return screen;
    }

    case "activate": {
      if (screen.name === "model-detail") {
        if (!screen.focus || screen.focus.area === "tabs") {
          return {
            ...screen,
            focus: { area: "fields", index: 0 },
          };
        }
      }
      return screen;
    }

    case "search-start": {
      if (screen.name === "models") {
        return { ...screen, searchActive: true };
      }
      return screen;
    }

    case "search-stop": {
      if (screen.name === "models") {
        return { ...screen, searchActive: false };
      }
      return screen;
    }

    case "search-input": {
      if (screen.name === "models") {
        return { ...screen, query: event.query, selectedIndex: 0 };
      }
      return screen;
    }

    case "tab-next": {
      if (screen.name === "model-detail") {
        if (screen.focus?.area === "fields") {
          const currentIndex = screen.focus.index;
          return {
            ...screen,
            focus: { area: "fields", index: currentIndex + 1 },
          };
        }
        const currentIdx = DETAIL_TABS.indexOf(screen.tab);
        const nextIdx = (currentIdx + 1) % DETAIL_TABS.length;
        const nextTab = DETAIL_TABS[nextIdx] ?? "overview";
        return { ...screen, tab: nextTab };
      }
      return screen;
    }

    case "tab-prev": {
      if (screen.name === "model-detail") {
        if (screen.focus?.area === "fields") {
          const currentIndex = screen.focus.index;
          return {
            ...screen,
            focus: { area: "fields", index: Math.max(0, currentIndex - 1) },
          };
        }
        const currentIdx = DETAIL_TABS.indexOf(screen.tab);
        const prevIdx = (currentIdx - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
        const prevTab = DETAIL_TABS[prevIdx] ?? "overview";
        return { ...screen, tab: prevTab };
      }
      return screen;
    }

    case "focus-fields": {
      if (screen.name === "model-detail") {
        return {
          ...screen,
          focus: { area: "fields", index: event.index ?? 0 },
        };
      }
      return screen;
    }

    case "focus-tabs": {
      if (screen.name === "model-detail") {
        return {
          ...screen,
          focus: { area: "tabs" },
        };
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
  event: NavigationEvent,
  maxIndex: number = 0,
  selectedProviderId?: string,
  selectedModelId?: string
): { stack: ScreenState[]; exited: boolean } {
  if (stack.length === 0) {
    return { stack: [], exited: true };
  }

  const currentScreen = stack[stack.length - 1];
  if (!currentScreen) {
    return { stack: [], exited: true };
  }

  if (event.type === "back") {
    if (currentScreen.name === "models" && currentScreen.searchActive) {
      const updatedScreen: ScreenState = { ...currentScreen, searchActive: false };
      return { stack: [...stack.slice(0, -1), updatedScreen], exited: false };
    }
    if (currentScreen.name === "model-detail" && currentScreen.focus?.area === "fields") {
      const updatedScreen: ScreenState = { ...currentScreen, focus: { area: "tabs" } };
      return { stack: [...stack.slice(0, -1), updatedScreen], exited: false };
    }
    return popScreen(stack);
  }

  if (event.type === "activate") {
    if (currentScreen.name === "main-menu") {
      const selectedOption = MENU_OPTIONS[currentScreen.selectedIndex];
      if (selectedOption === "models") {
        return {
          stack: pushScreen(stack, { name: "providers", selectedIndex: 0 }),
          exited: false,
        };
      }
      if (selectedOption === "quarantines") {
        return { stack: pushScreen(stack, { name: "quarantines" }), exited: false };
      }
    }

    if (currentScreen.name === "providers") {
      const targetProviderId = selectedProviderId ?? "unknown";
      return {
        stack: pushScreen(stack, {
          name: "models",
          providerId: targetProviderId,
          selectedIndex: 0,
          query: "",
          searchActive: false,
        }),
        exited: false,
      };
    }

    if (currentScreen.name === "models") {
      const targetModelId = selectedModelId ?? "unknown";
      return {
        stack: pushScreen(stack, {
          name: "model-detail",
          providerId: currentScreen.providerId,
          modelId: targetModelId,
          tab: "overview",
          focus: { area: "tabs" },
        }),
        exited: false,
      };
    }

    if (currentScreen.name === "model-detail") {
      if (!currentScreen.focus || currentScreen.focus.area === "tabs") {
        const updatedScreen: ScreenState = {
          ...currentScreen,
          focus: { area: "fields", index: 0 },
        };
        return { stack: [...stack.slice(0, -1), updatedScreen], exited: false };
      }
    }

    return { stack, exited: false };
  }

  const updatedScreen = transitionScreen(currentScreen, event, maxIndex);
  const updatedStack = [...stack.slice(0, -1), updatedScreen];
  return { stack: updatedStack, exited: false };
}
