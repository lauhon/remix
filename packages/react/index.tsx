import type { ReactNode } from "react";
import React from "react";
// TODO: Export Location from 'react-router'
import type { Location } from "history";
// TODO: Export RouteObject from 'react-router-dom'
import type { RouteObject, RouteMatch } from "react-router";
import {
  useLocation,
  useRoutes,
  useResolvedPath,
  Link as ReactRouterLink,
  matchRoutes
} from "react-router-dom";
import type {
  BuildManifest,
  EntryContext,
  RouteData,
  RouteDataResults,
  RouteManifest
} from "@remix-run/core";

import * as defaultRouteModule from "./defaultRouteModule";
import invariant from "./invariant";
import createHtml from "./createHtml";

interface ManifestPatcher {
  (path: string): void;
}

interface ManifestPatch {
  buildManifest: BuildManifest;
  routeManifest: RouteManifest;
}

async function fetchManifestPatch(path: string): Promise<ManifestPatch> {
  let res = await fetch(`/__remix_manifest?path=${path}`);
  return await res.json();
}

async function fetchDataResults(
  path: string,
  from?: string
): Promise<RouteDataResults> {
  let url = `/__remix_data?path=${path}`;
  if (from) url += `&from=${from}`;
  let res = await fetch(url);
  return await res.json();
}

interface ClientContext {
  dataCache: DataCache;
  manifestPatcher: ManifestPatcher;
  routes: RouteObject[];
  matches: RouteMatch[];
}

const RemixEntryContext = React.createContext<EntryContext | undefined>(
  undefined
);
const RemixClientContext = React.createContext<ClientContext | undefined>(
  undefined
);

function useEntryContext(): EntryContext {
  let context = React.useContext(RemixEntryContext);
  invariant(context, "You must render this element in a <Remix> component");
  return context;
}

function useClientContext(): ClientContext {
  let context = React.useContext(RemixClientContext);
  invariant(context, "You must render this element in a <Remix> component");
  return context;
}

export function RemixEntryProvider({
  context: entryContext,
  children
}: {
  context: EntryContext;
  children: ReactNode;
}) {
  let manifestPatcher = React.useCallback(async (path: string) => {
    let patch = await fetchManifestPatch(path);
    Object.assign(entryContext.browserManifest, patch.buildManifest);
    Object.assign(entryContext.routeManifest, patch.routeManifest);
  }, []);

  let location = useLocation();
  let [previousLocation, setPreviousLocation] = React.useState<Location>(
    location
  );

  let dataCache = useDataCache(entryContext.routeData);

  if (previousLocation !== location) {
    dataCache.preload(previousLocation);
    setPreviousLocation(location);
  }

  // TODO: Add renderRoutes to RR so we can manually match and render manually
  // on the client (do our own `useRoutes`)
  let routes = createRoutes(entryContext);
  let matches = matchRoutes(routes, location) || [];

  let clientContext = { dataCache, manifestPatcher, routes, matches };

  return (
    <RemixEntryContext.Provider value={entryContext}>
      <RemixClientContext.Provider value={clientContext}>
        {children}
      </RemixClientContext.Provider>
    </RemixEntryContext.Provider>
  );
}

interface StaticDataCache {
  preload(location: Location, fromLocation: Location): Promise<void>;
  read(locationKey: string, routeId?: string): RouteData[string];
}

function createStaticDataCache(
  initialKey: string,
  initialData: RouteData
): StaticDataCache {
  let cache: { [locationKey: string]: RouteData } = {
    [initialKey]: initialData
  };

  let inflight: {
    [locationKey: string]: Promise<RouteData>;
  } = {};

  async function preload(
    location: Location,
    fromLocation: Location
  ): Promise<void> {
    if (cache[location.key]) return;

    if (inflight[location.key]) return;

    inflight[location.key] = fetchDataResults(
      location.pathname,
      fromLocation?.pathname
    );

    try {
      let dataResults = await inflight[location.key];

      cache[location.key] = Object.keys(dataResults).reduce((memo, routeId) => {
        let dataResult = dataResults[routeId];

        if (dataResult.type === "data") {
          memo[routeId] = dataResult.data;
        } else if (dataResult.type === "copy") {
          invariant(
            fromLocation,
            `Cannot get a copy result with no fromLocation`
          );

          memo[routeId] = cache[fromLocation.key][routeId];
        }

        return memo;
      }, {} as RouteData);
    } catch (error) {
      // TODO: Handle errors
      console.error(error);
    } finally {
      delete inflight[location.key];
    }
  }

  function read(locationKey: string, routeId?: string) {
    if (inflight[locationKey]) {
      throw inflight[locationKey];
    }

    let locationData = cache[locationKey];

    invariant(locationData, `Missing data for location ${locationKey}`);

    if (!routeId) return locationData;

    invariant(
      locationData[routeId],
      `Missing data for route ${routeId} on location ${locationKey}`
    );

    return locationData[routeId];
  }

  return {
    preload,
    read
  };
}

interface DataCache {
  preload(fromLocation: Location): ReturnType<StaticDataCache["preload"]>;
  read(routeId?: string): ReturnType<StaticDataCache["read"]>;
}

function useDataCache(initialData: RouteData): DataCache {
  let location = useLocation();
  /* let [, forceUpdate] = React.useState(); */

  let cacheRef = React.useRef<StaticDataCache>();
  if (!cacheRef.current) {
    cacheRef.current = createStaticDataCache(location.key, initialData);
  }

  return React.useMemo<DataCache>(
    () => ({
      preload: (fromLocation: Location) =>
        cacheRef.current!.preload(location, fromLocation),
      read: (routeId?: string) => cacheRef.current!.read(location.key, routeId)
      /* getAllSync: () => cacheRef.current.getAllSync(location.key), */
      /* set: (routeId, value) => { */
      /*   cacheRef.current.set(location.key, routeId, value); */
      /*   forceUpdate({}); */
      /* } */
    }),
    [location]
  );
}

const RemixRouteIdContext = React.createContext<string | undefined>(undefined);

export function RemixRoute({ id }: { id: string }) {
  let { routeLoader } = useEntryContext();
  let routeModule = routeLoader.read(id);

  if (!routeModule) {
    return (
      <defaultRouteModule.default>
        <RemixRouteMissing id={id} />
      </defaultRouteModule.default>
    );
  }

  return (
    <RemixRouteIdContext.Provider value={id}>
      <routeModule.default />
    </RemixRouteIdContext.Provider>
  );
}

function RemixRouteMissing({ id }: { id: string }) {
  return <p>Missing route "{id}"!</p>;
}

export function useRouteData() {
  let routeId = React.useContext(RemixRouteIdContext);
  invariant(routeId, "Missing route id on context");

  let { dataCache } = useClientContext();
  let data = dataCache!.read(routeId);

  let setData = React.useCallback(
    nextData => {
      /* cache.set(routeId, nextData); */
    },
    [dataCache, routeId]
  );

  return [data, setData] as const;
}

export function Routes() {
  // TODO: Add `renderRoutes` function to RR that we can use here.
  return useRoutes(useClientContext().routes);
}

// TODO: React Router should not be calling preload on the server because you
// can't actually suspend on the server.
let canUseDom = typeof window === "object";

function createRoutes(entryContext: EntryContext): RouteObject[] {
  let routeIds = Object.keys(entryContext.routeManifest).sort();
  let routes: RouteObject[] = [];
  let addedRoutes: { [routeId: string]: RouteObject } = {};

  for (let routeId of routeIds) {
    let manifestRoute = entryContext.routeManifest[routeId];
    let route = {
      id: routeId,
      // TODO: Make this optional in RR
      caseSensitive: false,
      path: manifestRoute.path,
      element: <RemixRoute id={routeId} />,
      preload() {
        if (canUseDom) {
          entryContext.routeLoader.load(routeId);
        }
      }
    };

    if (manifestRoute.parentId == null) {
      routes.push(route);
    } else {
      let parentRoute = addedRoutes[manifestRoute.parentId];

      invariant(
        parentRoute,
        `Missing parent route "${manifestRoute.parentId}" for ${manifestRoute.id}`
      );

      (parentRoute.children || (parentRoute.children = [])).push(route);
    }

    addedRoutes[routeId] = route;
  }

  return routes;
}

export function Meta() {
  return (
    <React.Suspense fallback={null}>
      <AsyncMeta />
    </React.Suspense>
  );
}

function AsyncMeta() {
  let { routeLoader } = useEntryContext();
  let { dataCache, matches } = useClientContext();
  let location = useLocation();

  let meta: { [name: string]: string } = {};
  let allData = {};
  let routeData = dataCache.read();

  for (let match of matches) {
    // TODO: Make RouteMatch type more flexible somehow to allow for other
    // properties like `id`?
    // @ts-ignore
    let routeId = match.route.id;
    let data = routeData[routeId];
    let params = match.params;

    let routeModule = routeLoader.read(routeId) || defaultRouteModule;

    if (typeof routeModule.meta === "function") {
      Object.assign(allData, { [routeId]: data });
      Object.assign(
        meta,
        routeModule.meta({ data, params, location, allData })
      );
    }
  }

  return (
    <>
      {Object.keys(meta).map(name =>
        name === "title" ? (
          <title key="title">{meta[name]}</title>
        ) : (
          <meta key={name} name={name} content={meta[name]} />
        )
      )}
    </>
  );
}

export function Scripts() {
  let {
    browserManifest,
    publicPath,
    browserEntryContextString
  } = useEntryContext();

  let entryBrowser = browserManifest["entry-browser"];
  let src = `${publicPath}${entryBrowser.fileName}`;

  let browserIsHydrating = false;
  if (!browserEntryContextString) {
    browserIsHydrating = true;
    browserEntryContextString = "{}";
  }

  return (
    <>
      <script
        suppressHydrationWarning={browserIsHydrating}
        dangerouslySetInnerHTML={createHtml(
          `__remixContext = ${browserEntryContextString}`
        )}
      />
      <script type="module" src={src} />
    </>
  );
}

export function Styles() {
  let { browserManifest, publicPath } = useEntryContext();
  let { matches } = useClientContext();
  let styleFiles = [browserManifest["entry-styles"].fileName];

  for (let match of matches) {
    // @ts-ignore
    let routeId = match.route.id;
    if (browserManifest[`style/${routeId}`]) {
      styleFiles.push(browserManifest[`style/${routeId}`].fileName);
    }
  }

  return (
    <>
      {styleFiles.map(fileName => (
        <link key={fileName} rel="stylesheet" href={publicPath + fileName} />
      ))}
    </>
  );
}

export function Link(props: any) {
  let { manifestPatcher } = useClientContext();
  let resolvedPath = useResolvedPath(props.to);

  React.useEffect(() => {
    manifestPatcher!(resolvedPath.pathname);
  }, [resolvedPath]);

  return <ReactRouterLink {...props} />;
}
