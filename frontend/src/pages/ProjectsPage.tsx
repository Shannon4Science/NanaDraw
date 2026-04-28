import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Plus,
  FileText,
  Trash2,
  Pencil,
  MoreVertical,
  ArrowLeft,
} from "lucide-react";
import { useAuth } from "../contexts/AuthContext";
import { useT } from "../contexts/LanguageContext";
import { UserButton } from "../components/UserButton";
import type { TranslationKey } from "../i18n/zh";
import {
  createProject,
  deleteProject,
  listProjects,
  updateProject,
  thumbnailUrl,
  type ProjectInfo,
} from "../services/projectApi";

function timeAgo(
  dateStr: string | null,
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string,
): string {
  if (!dateStr) return "—";
  const normalized =
    dateStr.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr.replace(" ", "T") + "+08:00";
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("projects.justNow");
  const min = Math.floor(sec / 60);
  if (min < 60) return t("projects.minutesAgo", { n: String(min) });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("projects.hoursAgo", { n: String(hr) });
  const dayMs = 86400000;
  const days = Math.floor(diff / dayMs);
  if (days === 1) return t("projects.yesterday");
  if (days < 7) return t("projects.daysAgo", { n: String(days) });
  return d.toLocaleDateString();
}

export function ProjectsPage() {
  const t = useT();
  const navigate = useNavigate();
  const { isLoading: authLoading } = useAuth();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ProjectInfo | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const loadProjects = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const res = await listProjects(1, 50);
      setProjects(res.projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projects.loadFailed"));
      setProjects([]);
    } finally {
      setListLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (!authLoading) {
      void loadProjects();
    }
  }, [authLoading, loadProjects]);

  useEffect(() => {
    if (!menuProjectId) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuProjectId(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuProjectId]);

  useEffect(() => {
    if (!renameTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRenameTarget(null);
    };
    document.addEventListener("keydown", onKey);
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
    return () => document.removeEventListener("keydown", onKey);
  }, [renameTarget]);

  useEffect(() => {
    if (!newProjectOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNewProjectOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [newProjectOpen]);

  const openRename = (p: ProjectInfo) => {
    setMenuProjectId(null);
    setRenameTarget(p);
    setRenameValue(p.name);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await updateProject(renameTarget.id, { name });
      setProjects((prev) => prev.map((x) => (x.id === renameTarget.id ? { ...x, name } : x)));
      setRenameTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projects.renameFailed"));
    }
  };

  const handleDelete = async (p: ProjectInfo) => {
    setMenuProjectId(null);
    if (!window.confirm(t("projects.confirmDelete", { name: p.name }))) return;
    try {
      await deleteProject(p.id);
      setProjects((prev) => prev.filter((x) => x.id !== p.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projects.deleteFailed"));
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const { id } = await createProject(undefined, "drawio");
      setNewProjectOpen(false);
      navigate(`/draw?project=${id}&canvas=drawio&fresh=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("projects.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const openProject = (p: ProjectInfo) => {
    navigate(`/draw?project=${p.id}&canvas=drawio`);
  };

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-amber-50 via-white to-orange-50">
        <p className="text-gray-500">{t("projects.loading")}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-br from-amber-50 via-white to-orange-50">
      <header className="glass-panel flex items-center justify-between gap-4 px-6 py-3 shadow-soft">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2 text-gray-500 transition hover:text-amber-600"
            aria-label={t("projects.backHome")}
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div className="flex min-w-0 items-center gap-2">
            <img
              src={`${import.meta.env.BASE_URL}logo.jpg`}
              alt=""
              className="hidden h-9 w-9 rounded-lg object-contain sm:block"
            />
            <h1 className="truncate font-headline text-lg font-bold text-on-surface">{t("projects.myProjects")}</h1>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setNewProjectOpen(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-bold text-on-primary shadow-float transition-all hover:opacity-90 active:scale-95"
          >
            <Plus className="h-4 w-4" />
            {t("projects.newProject")}
          </button>
          <UserButton />
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
        {error && (
          <div
            className="mb-4 rounded-lg border border-red-100 bg-red-50 px-4 py-2 text-sm text-red-700"
            role="alert"
          >
            {error}
            <button type="button" className="ml-2 underline" onClick={() => setError(null)}>
              {t("projects.close")}
            </button>
          </div>
        )}

        {listLoading ? (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="animate-pulse overflow-hidden rounded-xl border border-gray-100 bg-white shadow-sm"
              >
                <div className="aspect-video bg-gray-100" />
                <div className="space-y-2 p-4">
                  <div className="h-4 w-2/3 rounded bg-gray-100" />
                  <div className="h-3 w-1/2 rounded bg-gray-100" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-primary/20 bg-surface-container-lowest/60 px-8 py-20 text-center shadow-soft">
            <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-container/20">
              <FileText className="h-10 w-10 text-primary-container" />
            </div>
            <h2 className="mb-2 text-lg font-semibold text-gray-900">{t("projects.emptyTitle")}</h2>
            <p className="mb-6 max-w-sm text-sm text-gray-500">{t("projects.emptyDesc")}</p>
            <button
              type="button"
              onClick={() => setNewProjectOpen(true)}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-bold text-on-primary shadow-float transition-all hover:opacity-90 active:scale-95"
            >
              <Plus className="h-4 w-4" />
              {t("projects.newProject")}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {projects.map((p) => (
              <div
                key={p.id}
                className="group relative overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-soft transition-all hover:shadow-float"
              >
                <button
                  type="button"
                  onClick={() => openProject(p)}
                  className="block w-full text-left"
                >
                  <div className="relative aspect-video bg-gray-100">
                    {p.thumbnail_url ? (
                      <img
                        src={thumbnailUrl(p.id)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-gray-300">
                        <FileText className="h-14 w-14" />
                      </div>
                    )}
                  </div>
                  <div className="p-4">
                    <p className="truncate font-semibold text-gray-900">{p.name}</p>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="inline-flex shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                        Draw.io
                      </span>
                      <span className="truncate text-xs text-gray-400">
                        {timeAgo(p.updated_at, t)}
                      </span>
                    </div>
                  </div>
                </button>
                <div
                  className="absolute right-2 top-2"
                  ref={menuProjectId === p.id ? menuRef : undefined}
                >
                  <button
                    type="button"
                    aria-expanded={menuProjectId === p.id}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuProjectId((id) => (id === p.id ? null : p.id));
                    }}
                    className="rounded-lg bg-white/90 p-1.5 text-gray-500 shadow-sm backdrop-blur transition hover:bg-white hover:text-gray-800"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </button>
                  {menuProjectId === p.id && (
                    <ul
                      role="menu"
                      className="absolute right-0 z-10 mt-1 min-w-[9rem] rounded-lg border border-gray-100 bg-white py-1 text-sm shadow-lg"
                    >
                      <li>
                        <button
                          type="button"
                          role="menuitem"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-gray-700 hover:bg-gray-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRename(p);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                          {t("projects.rename")}
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          role="menuitem"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-red-600 hover:bg-red-50"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDelete(p);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                          {t("projects.delete")}
                        </button>
                      </li>
                    </ul>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-gray-100 bg-white/60 px-6 py-3 text-center text-xs text-gray-400">
        NanaDraw © {new Date().getFullYear()}
      </footer>

      {renameTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onClick={() => setRenameTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-project-title"
            className="w-full max-w-md rounded-xl border border-gray-100 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.stopPropagation();
            }}
          >
            <h2 id="rename-project-title" className="mb-4 text-lg font-semibold text-gray-900">
              {t("projects.renameProject")}
            </h2>
            <input
              ref={renameInputRef}
              type="text"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none ring-amber-500 focus:ring-2"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submitRename();
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
                onClick={() => setRenameTarget(null)}
              >
                {t("projects.cancel")}
              </button>
              <button
                type="button"
                className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600"
                onClick={() => void submitRename()}
              >
                {t("projects.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {newProjectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          role="presentation"
          onClick={() => !creating && setNewProjectOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
            className="w-full max-w-md rounded-xl border border-gray-100 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="new-project-title" className="mb-1 text-lg font-semibold text-gray-900">
              {t("projects.newProjectTitle")}
            </h2>
            <p className="mb-4 text-sm text-gray-500">{t("projects.willCreateDrawio")}</p>
            <button
              type="button"
              disabled={creating}
              onClick={() => void handleCreate()}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-3 text-sm font-semibold text-white shadow-md transition hover:bg-amber-600 disabled:opacity-50"
            >
              <FileText className="h-5 w-5" />
              {t("projects.createProject")}
            </button>
            <button
              type="button"
              disabled={creating}
              className="mt-4 w-full rounded-lg py-2 text-sm text-gray-500 hover:bg-gray-50"
              onClick={() => setNewProjectOpen(false)}
            >
              {t("projects.cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
