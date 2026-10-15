/**
 * Window layout: sidebar, AI dock, tree expansion. Persisted with the session.
 */
import { clamp } from '$lib/utils';

export interface LayoutState {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  aiOpen: boolean;
  aiWidth: number;
  expanded: string[];
}

export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 520;
export const AI_MIN = 300;
export const AI_MAX = 720;

class LayoutStore {
  sidebarWidth = $state(264);
  sidebarCollapsed = $state(false);
  aiOpen = $state(false);
  aiWidth = $state(380);
  /** Expanded tree node keys. */
  expanded = $state<Record<string, boolean>>({});

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
  }

  toggleAi(): void {
    this.aiOpen = !this.aiOpen;
  }

  isExpanded(key: string): boolean {
    return !!this.expanded[key];
  }

  setExpanded(key: string, open: boolean): void {
    if (open) this.expanded[key] = true;
    else delete this.expanded[key];
  }

  serialize(): LayoutState {
    return {
      sidebarWidth: this.sidebarWidth,
      sidebarCollapsed: this.sidebarCollapsed,
      aiOpen: this.aiOpen,
      aiWidth: this.aiWidth,
      expanded: Object.keys(this.expanded)
    };
  }

  restore(s: Partial<LayoutState> | undefined): void {
    if (!s) return;
    if (typeof s.sidebarWidth === 'number') this.sidebarWidth = clamp(s.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX);
    if (typeof s.sidebarCollapsed === 'boolean') this.sidebarCollapsed = s.sidebarCollapsed;
    if (typeof s.aiOpen === 'boolean') this.aiOpen = s.aiOpen;
    if (typeof s.aiWidth === 'number') this.aiWidth = clamp(s.aiWidth, AI_MIN, AI_MAX);
    if (Array.isArray(s.expanded)) this.expanded = Object.fromEntries(s.expanded.map((k) => [k, true]));
  }
}

export const layout = new LayoutStore();
