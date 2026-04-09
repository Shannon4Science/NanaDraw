import { useCallback, useRef, useState } from "react";
import {
  type AssetGenItem,
  type AssetStyle,
  generateAssetFromImage,
  generateAssetsSSE,
} from "../services/api";

export interface UseAssetGeneratorReturn {
  generating: boolean;
  results: AssetGenItem[];
  error: string | null;
  queuePosition: number | null;
  queueTotal: number | null;
  progress: { index: number; total: number } | null;
  generateFromText: (descriptions: string[], style: AssetStyle, imageModel?: string, styleText?: string) => Promise<void>;
  generateFromImage: (file: File, style: AssetStyle, imageModel?: string, styleText?: string) => Promise<void>;
  clearResults: () => void;
  cancel: () => void;
}

export function useAssetGenerator(): UseAssetGeneratorReturn {
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<AssetGenItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [queuePosition, setQueuePosition] = useState<number | null>(null);
  const [queueTotal, setQueueTotal] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const generateFromText = useCallback(
    async (descriptions: string[], style: AssetStyle, imageModel?: string, styleText?: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setGenerating(true);
      setError(null);
      setResults([]);
      setQueuePosition(null);
      setQueueTotal(null);
      setProgress(null);

      try {
        await generateAssetsSSE(
          descriptions,
          style,
          imageModel,
          {
            onQueuePosition: ({ position, total }) => {
              setQueuePosition(position);
              setQueueTotal(total);
            },
            onAssetStart: ({ total }) => {
              setQueuePosition(null);
              setQueueTotal(null);
              setProgress({ index: 0, total });
            },
            onAssetProgress: (data) => {
              setProgress({ index: data.index, total: data.total });
              if (data.status === "success" && data.image_b64) {
                setResults((prev) => [...prev, { description: data.description, image_b64: data.image_b64! }]);
              }
            },
            onAssetComplete: () => {
              setGenerating(false);
              setProgress(null);
            },
            onError: (data) => {
              setError(data.message);
              setGenerating(false);
            },
            onClose: () => {
              setGenerating(false);
              setProgress(null);
            },
          },
          controller.signal,
          styleText,
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "生成失败");
        setGenerating(false);
      }
    },
    [],
  );

  const generateFromImage = useCallback(
    async (file: File, style: AssetStyle, imageModel?: string, styleText?: string) => {
      setGenerating(true);
      setError(null);
      try {
        const resp = await generateAssetFromImage(file, style, imageModel, styleText);
        setResults([{ description: file.name, image_b64: resp.image_b64 }]);
      } catch (e) {
        setError(e instanceof Error ? e.message : "风格化失败");
      } finally {
        setGenerating(false);
      }
    },
    [],
  );

  const clearResults = useCallback(() => {
    setResults([]);
    setError(null);
    setQueuePosition(null);
    setQueueTotal(null);
    setProgress(null);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
  }, []);

  return {
    generating, results, error, queuePosition, queueTotal, progress,
    generateFromText, generateFromImage, clearResults, cancel,
  };
}
