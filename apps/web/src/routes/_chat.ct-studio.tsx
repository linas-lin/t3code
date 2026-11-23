import { createFileRoute } from "@tanstack/react-router";

import { CtStudioPage, ctStudioSearchFromUrl } from "../components/ctStudio/CtStudioPage";
import { useCtStudioStore } from "../components/ctStudio/ctStudioStore";

export const Route = createFileRoute("/_chat/ct-studio")({
  validateSearch: ctStudioSearchFromUrl,
  onEnter: ({ search }) => {
    useCtStudioStore.getState().openFromRoute(search);
  },
  onStay: ({ search }) => {
    useCtStudioStore.getState().openFromRoute(search);
  },
  component: CtStudioPage,
});
