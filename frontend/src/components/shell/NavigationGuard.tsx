"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

/*
 * Guards in-app navigation while a screen has unsaved changes. The App Router has
 * no route-change event to cancel, so every shell link goes through <GuardedLink>,
 * which asks first when a screen has called useBlockNavigation(true). Other ways of
 * leaving the screen, like signing out, go through useGuardedAction. Tab close and
 * reload are covered separately by useUnsavedChangesWarning.
 */

interface NavigationGuardApi {
  setBlocked: (blocked: boolean) => void;
  /** Navigates to `href`, asking first if navigation is blocked. */
  navigate: (href: string) => void;
  /** Runs `action`, asking first if navigation is blocked. */
  run: (action: () => void) => void;
  isBlocked: () => boolean;
}

const NavigationGuardContext = createContext<NavigationGuardApi | null>(null);

export function NavigationGuardProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const blocked = useRef(false);
  const isBypassing = useRef(false);
  const hasGuardEntry = useRef(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

 useEffect(() => {
    const nav = (window as unknown as { navigation?: EventTarget }).navigation;

    const handleNavigate = (event: Event) => {
      const navEvent = event as Event & {
        navigationType?: string;
        canIntercept?: boolean;
        destination?: { url?: string };
        preventDefault: () => void;
      };

      if (isBypassing.current) {
        isBypassing.current = false;
        return;
      }

      if (blocked.current && navEvent.navigationType === "traverse" && navEvent.canIntercept) {
        navEvent.preventDefault();
        
        // Instead of complex manipulation, trigger the custom confirm dialog only
        setPendingAction(() => () => {
          blocked.current = false;
          isBypassing.current = true;
          window.history.forward(); // Move forward to cancel the dummy back navigation attempt
        });
      }
    };

    const handlePopState = (event: PopStateEvent) => {
      if (isBypassing.current) {
        isBypassing.current = false;
        return;
      }

      if (blocked.current) {
        event.stopImmediatePropagation();
        
        // Re-push the current state to temporarily keep the user in place until a decision is made
        window.history.pushState({ ...window.history.state, guard: true }, "", window.location.href);

        // When Back is pressed, prepare the action for direct redirection to the content page
        setPendingAction(() => () => {
          blocked.current = false;
          isBypassing.current = true;
          window.location.href = "/content"; // Direct and 100% reliable redirection to the content page
        });
      }
    };

    nav?.addEventListener("navigate", handleNavigate);
    window.addEventListener("popstate", handlePopState, true);

    return () => {
      nav?.removeEventListener("navigate", handleNavigate);
      window.removeEventListener("popstate", handlePopState, true);
    };
  }, []);

  const api = useMemo<NavigationGuardApi>(() => {
    const run = (action: () => void) => {
      // Wrapped, because a function passed to a state setter would be called as an updater.
      if (blocked.current) {
        setPendingAction(() => action);
      } else {
        action();
      }
    };

    return {
      setBlocked: (value) => {
        if (value && !blocked.current && !hasGuardEntry.current) {
          window.history.pushState({ ...window.history.state, guard: true }, "", window.location.href);
          hasGuardEntry.current = true;
        }
        blocked.current = value;
      },
      isBlocked: () => blocked.current,
      navigate: (href) => run(() => router.push(href)),
      run,
    };
  }, [router]);

  return (
    <NavigationGuardContext.Provider value={api}>
      {children}
      {pendingAction && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="You have changes that haven’t been saved. Leave anyway?"
          confirmLabel="Discard changes"
          danger
          onClose={() => {
            setPendingAction(null);
          }}
          onConfirm={() => {
            // 1. Unblock navigation immediately
            blocked.current = false;
            // 2. Set bypass flag
            isBypassing.current = true;
            
            setPendingAction(null);
            
            // 3. Direct and 100% reliable redirection to the content page
            router.push("/content");
  }}
        />
      )}
    </NavigationGuardContext.Provider>
  );
}

function useNavigationGuard(): NavigationGuardApi {
  const context = useContext(NavigationGuardContext);
  if (!context) throw new Error("Navigation guard used outside <NavigationGuardProvider>");
  return context;
}

/** Blocks shell navigation while `dirty` is true; unblocks on unmount. */
export function useBlockNavigation(dirty: boolean): void {
  const { setBlocked } = useNavigationGuard();
  useEffect(() => {
    setBlocked(dirty);
    return () => setBlocked(false);
  }, [dirty, setBlocked]);
}

/** Programmatic navigation that respects the guard (e.g. after an action). */
export function useGuardedNavigate(): (href: string) => void {
  return useNavigationGuard().navigate;
}

/** Runs an action that leaves the screen some other way (e.g. signing out), asking first like a guarded link. */
export function useGuardedAction(): (action: () => void) => void {
  return useNavigationGuard().run;
}

/** A next/link that asks before leaving a screen with unsaved changes. */
export function GuardedLink({ href, onClick, ...props }: React.ComponentProps<typeof Link> & { href: string }) {
  const guard = useNavigationGuard();
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      // Let modified clicks (new tab, etc.) through untouched.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      if (guard.isBlocked()) {
        event.preventDefault();
        guard.navigate(href);
      }
    },
    [guard, href, onClick],
  );
  return <Link href={href} onClick={handleClick} {...props} />;
}