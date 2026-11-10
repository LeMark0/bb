import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import { hasInitRequest, initRequest } from './init-request.ts'

export type DraftTarget = {
  isAvailable: boolean
  text: () => string
  insert: (text: string) => void
  focus: () => void
}

export type ProjectState =
  | { status: 'loading' }
  | { status: 'ready'; name: string; root: string }
  | { status: 'error'; message: string; code?: string }

export type BindOutcome =
  | { ok: true; path: string; title: string; alreadyBound: boolean }
  | { ok: false; message: string }

type Props = {
  project: ProjectState
  draft: DraftTarget
  bind: (path: string) => Promise<BindOutcome>
  onBound: () => void
  onRetryProject?: () => void
}

type InitState = { kind: 'idle' } | { kind: 'added' } | { kind: 'already' } | { kind: 'error'; message: string }
type BindState =
  | { kind: 'closed' }
  | { kind: 'open' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'bound'; message: string }
type FocusTarget = 'field' | 'opener' | null

const primary =
  'inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50'
const secondary =
  'inline-flex items-center rounded-md border border-border px-3 py-1.5 text-sm text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50'

export function InitActions({ project, draft, bind, onBound, onRetryProject }: Props) {
  const [init, setInit] = useState<InitState>({ kind: 'idle' })
  const [binding, setBinding] = useState<BindState>({ kind: 'closed' })
  const [path, setPath] = useState('')
  const [focusTarget, setFocusTarget] = useState<FocusTarget>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLButtonElement>(null)
  const initRef = useRef<HTMLButtonElement>(null)
  const retryRef = useRef<HTMLButtonElement>(null)
  const retrying = useRef(false)
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()
  const ready = project.status === 'ready' ? project : null
  const busy = binding.kind === 'checking' || binding.kind === 'bound'

  useEffect(
    function moveFocus() {
      if (focusTarget === 'field') {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      if (focusTarget === 'opener') openerRef.current?.focus()
      if (focusTarget) setFocusTarget(null)
    },
    [focusTarget, binding],
  )

  useEffect(
    function focusAfterRetry() {
      if (!retrying.current || project.status === 'loading') return
      retrying.current = false
      const active = document.activeElement
      if (active && active !== document.body) return
      if (project.status === 'error') retryRef.current?.focus()
      else if (initRef.current && !initRef.current.disabled) initRef.current.focus()
      else openerRef.current?.focus()
    },
    [project],
  )

  const retryProject = () => {
    if (!onRetryProject) return
    retrying.current = true
    onRetryProject()
  }

  const addRequest = () => {
    if (!ready) return
    try {
      if (hasInitRequest(draft.text())) {
        setInit({ kind: 'already' })
        draft.focus()
        return
      }
      draft.insert(initRequest(ready.name))
      draft.focus()
      setInit({ kind: 'added' })
    } catch (reason) {
      setInit({ kind: 'error', message: reason instanceof Error ? reason.message : String(reason) })
    }
  }

  const openForm = () => {
    setBinding({ kind: 'open' })
    setFocusTarget('field')
  }

  const closeForm = () => {
    if (binding.kind === 'checking') return
    setBinding({ kind: 'closed' })
    setPath('')
    setFocusTarget('opener')
  }

  const fail = (message: string) => {
    setBinding({ kind: 'error', message })
    setFocusTarget('field')
  }

  const submitPath = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    if (path.trim() === '') {
      fail('Enter the path of the plan file.')
      return
    }
    setBinding({ kind: 'checking' })
    try {
      const outcome = await bind(path)
      if (!outcome.ok) {
        fail(outcome.message)
        return
      }
      setBinding({
        kind: 'bound',
        message: outcome.alreadyBound ? `${outcome.title} is already bound. Opening it.` : `Bound ${outcome.title}. Opening it.`,
      })
      onBound()
    } catch (reason) {
      fail(`Couldn't bind the plan: ${reason instanceof Error ? reason.message : String(reason)}. Press Bind plan to try again.`)
    }
  }

  const onFormKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeForm()
  }

  if (project.status === 'loading') {
    return <p className="mt-4 text-sm text-muted-foreground" data-init-actions="">Checking this project…</p>
  }
  if (project.status === 'error' && project.code === 'no_project_folder') {
    return (
      <p className="mt-4 text-sm text-muted-foreground" data-init-actions="" role="status">
        Plan Map can't set up a plan here because this project has no local folder. Plan Map works with projects that have one.
      </p>
    )
  }
  if (project.status === 'error') {
    return (
      <div className="mt-4 mb-6 flex flex-col items-start gap-3" data-init-actions="" role="status">
        <span className="text-sm text-destructive-text">Plan Map couldn't check this project. {project.message}</span>
        {onRetryProject ? (
          <button ref={retryRef} type="button" className={secondary} onClick={retryProject} data-project-retry="">
            Try again
          </button>
        ) : null}
      </div>
    )
  }

  const describedBy = binding.kind === 'error' ? `${errorId} ${hintId}` : hintId

  return (
    <div className="mt-5 flex max-w-xl flex-col gap-4" data-init-actions="">
      <section className="flex flex-col gap-2" aria-labelledby={`${inputId}-init`}>
        <h2 id={`${inputId}-init`} className="sr-only">
          Initialise a plan
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={initRef} type="button" className={primary} onClick={addRequest} disabled={!draft.isAvailable} data-init-button="">
            Initialise plan
          </button>
          {binding.kind === 'closed' ? (
            <button ref={openerRef} type="button" className={secondary} onClick={openForm} data-bind-open="">
              Bind existing plan
            </button>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {draft.isAvailable
            ? `Adds a request for “${ready?.name}” to this conversation's message box. Nothing runs until you send it.`
            : 'Open Plan Map from a conversation to add the request to its message box.'}
        </p>
        <p className="text-sm" role="status" aria-live="polite" data-init-status="">
          {init.kind === 'added' ? 'Request added to the message box. Review it and press Send. The map appears here once the plan is bound.' : null}
          {init.kind === 'already' ? 'The request is already in the message box. Review it and press Send.' : null}
          {init.kind === 'error' ? <span className="text-destructive-text">Couldn't add the request: {init.message}. Try again.</span> : null}
        </p>
      </section>
      {binding.kind !== 'closed' ? (
        <form
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          onSubmit={(event) => void submitPath(event)}
          onKeyDown={onFormKeyDown}
          aria-busy={binding.kind === 'checking'}
          data-bind-form=""
        >
          <label htmlFor={inputId} className="text-sm font-medium text-foreground">
            Plan Map ADR (Markdown file)
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="docs/adr/0001-feature.md"
            aria-describedby={describedBy}
            aria-invalid={binding.kind === 'error'}
            autoComplete="off"
            spellCheck={false}
            readOnly={busy}
            className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring read-only:opacity-70"
          />
          {binding.kind === 'error' ? (
            <p id={errorId} className="whitespace-pre-wrap text-sm text-destructive-text" role="alert" data-bind-error="">
              {binding.message}
            </p>
          ) : null}
          <p id={hintId} className="text-xs text-muted-foreground">
            The path is relative to {ready?.root}. Plans that are already bound stay bound.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={primary} aria-disabled={busy}>
              {binding.kind === 'checking' ? 'Checking…' : 'Bind plan'}
            </button>
            <button type="button" className={secondary} aria-disabled={binding.kind === 'checking'} onClick={closeForm}>
              Cancel
            </button>
          </div>
          <p className="text-sm" role="status" aria-live="polite" data-bind-status="">
            {binding.kind === 'bound' ? binding.message : null}
          </p>
        </form>
      ) : null}
    </div>
  )
}
