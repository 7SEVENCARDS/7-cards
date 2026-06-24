import { createFileRoute, redirect } from "@tanstack/react-router";

  // /join?ref=CODE — handles all existing shared referral links.
  // Immediately redirects to / with the ref param preserved so the signup
  // flow can auto-apply the referral code.
  export const Route = createFileRoute("/join")({
    validateSearch: (search: Record<string, unknown>) => ({
      ref:
        typeof search.ref === "string"
          ? search.ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10)
          : undefined,
    }),
    beforeLoad: ({ search }) => {
      throw redirect({
        to: "/",
        search: search.ref ? { ref: search.ref } : {},
        replace: true,
      });
    },
    component: () => null,
  });
  