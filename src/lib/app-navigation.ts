type SearchParamReader = Pick<URLSearchParams, "get">;

const SHARED_FILTER_KEYS = ["perspective", "range"] as const;

export function buildAppHref(pathname: string, searchParams: SearchParamReader) {
  const params = new URLSearchParams();

  for (const key of SHARED_FILTER_KEYS) {
    const value = searchParams.get(key);

    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}
