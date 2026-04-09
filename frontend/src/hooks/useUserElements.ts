import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  deleteUserElement,
  fetchUserElementContent,
  fetchUserElements,
  uploadUserElement,
  type UserElement,
} from "../services/api";

export function useUserElements() {
  const { isLoggedIn } = useAuth();
  const [elements, setElements] = useState<UserElement[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isLoggedIn) {
      setElements([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await fetchUserElements({ size: 200 });
      setElements(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const upload = useCallback(
    async (file: File, displayName?: string, category?: string) => {
      setUploading(true);
      setError(null);
      try {
        const el = await uploadUserElement(file, displayName, category);
        setElements((prev) => [el, ...prev]);
        return el;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "上传失败";
        setError(msg);
        throw e;
      } finally {
        setUploading(false);
      }
    },
    [],
  );

  const remove = useCallback(async (elementId: string) => {
    try {
      await deleteUserElement(elementId);
      setElements((prev) => prev.filter((el) => el.id !== elementId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  }, []);

  const getContent = useCallback(async (elementId: string) => {
    return fetchUserElementContent(elementId);
  }, []);

  return { elements, loading, uploading, error, upload, remove, refresh, getContent };
}
