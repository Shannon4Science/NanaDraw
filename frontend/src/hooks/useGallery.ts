import { useCallback, useEffect, useRef, useState } from "react";
import { fetchGallery, searchGallery } from "../services/api";
import type { GallerySearchResult, StyleReference } from "../types/paper";

export function useGallery() {
  const [items, setItems] = useState<StyleReference[]>([]);
  const [searchResults, setSearchResults] = useState<GallerySearchResult[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchIdRef = useRef(0);

  const load = useCallback(async (category?: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchGallery(category);
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load gallery");
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    const id = ++searchIdRef.current;
    setSearching(true);
    try {
      const data = await searchGallery(query.trim());
      if (id === searchIdRef.current) {
        setSearchResults(data);
      }
    } catch (e) {
      if (id === searchIdRef.current) {
        setError(e instanceof Error ? e.message : "Search failed");
        setSearchResults(null);
      }
    } finally {
      if (id === searchIdRef.current) {
        setSearching(false);
      }
    }
  }, []);

  const clearSearch = useCallback(() => {
    searchIdRef.current++;
    setSearchResults(null);
    setSearching(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return {
    items,
    searchResults,
    loading,
    searching,
    error,
    reload: load,
    search,
    clearSearch,
  };
}
