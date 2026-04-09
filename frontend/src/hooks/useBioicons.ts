import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBioiconCategories,
  fetchBioicons,
  fetchBioiconSvg,
  type BioiconCategoryData,
  type BioiconItemData,
} from "../services/api";

export function useBioicons() {
  const [categories, setCategories] = useState<BioiconCategoryData[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [icons, setIcons] = useState<BioiconItemData[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inserting, setInserting] = useState<string | null>(null);
  const reqIdRef = useRef(0);

  const LIMIT = 60;

  const loadCategories = useCallback(async () => {
    try {
      const data = await fetchBioiconCategories();
      setCategories(data);
    } catch (e) {
      console.error("Failed to load bioicon categories:", e);
    }
  }, []);

  const loadIcons = useCallback(
    async (cat: string | null, q: string, pg: number, append: boolean) => {
      const id = ++reqIdRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const data = await fetchBioicons({
          category: cat ?? undefined,
          q: q || undefined,
          page: pg,
          limit: LIMIT,
        });
        if (id !== reqIdRef.current) return;
        if (append) {
          setIcons((prev) => [...prev, ...data.items]);
        } else {
          setIcons(data.items);
        }
        setTotal(data.total);
        setPage(pg);
      } catch (e) {
        console.error("Failed to load bioicons:", e);
      } finally {
        if (id === reqIdRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadIcons(selectedCategory, query, 1, false);
  }, [selectedCategory, query, loadIcons]);

  const loadMore = useCallback(() => {
    if (loadingMore || loading) return;
    if (icons.length >= total) return;
    loadIcons(selectedCategory, query, page + 1, true);
  }, [loadingMore, loading, icons.length, total, selectedCategory, query, page, loadIcons]);

  const selectCategory = useCallback((cat: string | null) => {
    setSelectedCategory(cat);
    setPage(1);
  }, []);

  const search = useCallback((q: string) => {
    setQuery(q);
    setPage(1);
  }, []);

  const getSvgBase64 = useCallback(async (iconId: string): Promise<string> => {
    setInserting(iconId);
    try {
      const svgText = await fetchBioiconSvg(iconId);
      return btoa(unescape(encodeURIComponent(svgText)));
    } finally {
      setInserting(null);
    }
  }, []);

  const hasMore = icons.length < total;

  return {
    categories,
    selectedCategory,
    selectCategory,
    icons,
    total,
    loading,
    loadingMore,
    hasMore,
    loadMore,
    query,
    search,
    inserting,
    getSvgBase64,
  };
}
