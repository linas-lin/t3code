import { createFileRoute, useLocation } from "@tanstack/react-router";

import {
  PluginPage,
  parsePluginSearchString,
  pluginSearchFromRaw,
  type PluginRouteSearch,
} from "../components/plugins/PluginPage";
import { usePluginStore } from "../components/plugins/pluginStore";

function dispatchPluginRouteNavigation(pluginId: string, search: PluginRouteSearch) {
  const { subpath, ...rest } = search;
  usePluginStore.getState().dispatchPluginNavigation(pluginId, {
    ...(subpath ? { subpath } : {}),
    search: rest,
  });
}

function PluginRouteComponent() {
  const { pluginId } = Route.useParams();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const search = parsePluginSearchString(searchStr);
  return <PluginPage pluginId={pluginId} search={search} />;
}

export const Route = createFileRoute("/_chat/plugins/$pluginId")({
  onEnter: ({ params, search }) => {
    dispatchPluginRouteNavigation(params.pluginId, pluginSearchFromRaw(search));
  },
  onStay: ({ params, search }) => {
    dispatchPluginRouteNavigation(params.pluginId, pluginSearchFromRaw(search));
  },
  component: PluginRouteComponent,
});
