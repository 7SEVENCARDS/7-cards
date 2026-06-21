import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { User, Session } from "@supabase/supabase-js";

export type SessionState = {
  user: User | null;
  session: Session | null;
  loading: boolean;
};

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({
    user: null,
    session: null,
    loading: true,
  });

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setState({
        user: session?.user ?? null,
        session,
        loading: false,
      });
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setState({
          user: session?.user ?? null,
          session,
          loading: false,
        });

        // Link device to Supabase user ID for OneSignal server-side push targeting.
        // Requires OneSignal Web SDK to be initialised in __root.tsx:
        //   <script src="https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js" defer></script>
        if (session?.user?.id) {
          try {
            const os = (window as unknown as { OneSignal?: { login: (id: string) => void } }).OneSignal;
            if (os?.login) os.login(session.user.id);
          } catch { /* OneSignal not loaded — add SDK script to __root.tsx */ }
        } else {
          try {
            const os = (window as unknown as { OneSignal?: { logout: () => void } }).OneSignal;
            if (os?.logout) os.logout();
          } catch { /* non-critical */ }
        }
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  return state;
}
