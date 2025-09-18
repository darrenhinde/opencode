import { createEffect, createMemo, For, Match, Show, Switch, type Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import highlight from "tree-sitter-highlight"
import path from "path"
import { useRouteData } from "./context/route"
import { useSync } from "./context/sync"
import { SplitBorder } from "./component/border"
import { Theme } from "./context/theme"
import { hastToStyledText, RGBA, ScrollBoxRenderable, SyntaxStyle } from "@opentui/core"
import { Prompt } from "./component/prompt"
import type { AssistantMessage, Part, ToolPart, ToolStatePending, UserMessage } from "@opencode-ai/sdk"
import type { TextPart } from "ai"
import { useLocal } from "./context/local"
import { Locale } from "../../../util/locale"
import type { Tool } from "../../../tool/tool"

import type { ReadTool } from "../../../tool/read"
import type { WriteTool } from "../../../tool/write"
import { BashTool } from "../../../tool/bash"
import type { GlobTool } from "../../../tool/glob"
import { Instance } from "../../../project/instance"
import { TodoWriteTool } from "../../../tool/todo"
import type { GrepTool } from "../../../tool/grep"
import type { ListTool } from "../../../tool/ls"
import type { EditTool } from "../../../tool/edit"
import type { PatchTool } from "../../../tool/patch"
import type { WebFetchTool } from "../../../tool/webfetch"
import type { TaskTool } from "../../../tool/task"
import { useKeyboard } from "@opentui/solid"
import { parsePatch } from "diff"

export function Session() {
  const route = useRouteData("session")
  const sync = useSync()
  const session = createMemo(() => sync.session.get(route.sessionID)!)
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const todo = createMemo(() => sync.data.todo[route.sessionID] ?? [])
  let scroll: ScrollBoxRenderable

  createEffect(() => sync.session.sync(route.sessionID))

  useKeyboard((evt) => {
    if (evt.name === "pageup") scroll.scrollBy(-scroll.height)
    if (evt.name === "pagedown") scroll.scrollBy(scroll.height)
  })

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} flexGrow={1} maxHeight="100%">
      <Show when={session()}>
        <box paddingLeft={1} paddingRight={1} {...SplitBorder} borderColor={Theme.backgroundElement}>
          <text>
            <span style={{ bold: true, fg: Theme.accent }}>#</span>{" "}
            <span style={{ bold: true }}>{session().title}</span>
          </text>
          <box flexDirection="row">
            <Switch>
              <Match when={session().share?.url}>
                <text fg={Theme.textMuted}>{session().share!.url}</text>
              </Match>
              <Match when={true}>
                <text>
                  /share <span style={{ fg: Theme.textMuted }}>to create a shareable link</span>
                </text>
              </Match>
            </Switch>
          </box>
        </box>
        <scrollbox
          ref={(r: any) => (scroll = r)}
          scrollbarOptions={{ visible: false }}
          stickyScroll={true}
          stickyStart="bottom"
          paddingTop={1}
          paddingBottom={1}
          contentOptions={{
            flexGrow: 1,
            gap: 1,
          }}
        >
          <For each={messages()}>
            {(message) => (
              <Switch>
                <Match when={message.role === "user"}>
                  <UserMessage message={message as UserMessage} parts={sync.data.part[message.id] ?? []} />
                </Match>
                <Match when={message.role === "assistant"}>
                  <AssistantMessage message={message as AssistantMessage} parts={sync.data.part[message.id] ?? []} />
                </Match>
              </Switch>
            )}
          </For>
        </scrollbox>
        <Show when={todo().length > 0}>
          <box paddingBottom={1}>
            <For each={todo()}>
              {(todo) => (
                <text style={{ fg: todo.status === "in_progress" ? Theme.success : Theme.textMuted }}>
                  [{todo.status === "completed" ? "✓" : " "}] {todo.content}
                </text>
              )}
            </For>
          </box>
        </Show>
        <box flexShrink={0}>
          <Prompt sessionID={route.sessionID} />
        </box>
      </Show>
    </box>
  )
}

function UserMessage(props: { message: UserMessage; parts: Part[] }) {
  const text = createMemo(() => props.parts.flatMap((x) => (x.type === "text" && !x.synthetic ? [x] : []))[0])
  const sync = useSync()
  return (
    <box
      id={text()?.id}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      backgroundColor={Theme.backgroundPanel}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={Theme.secondary}
    >
      <text>{text()?.text}</text>
      <text>
        {sync.data.config.username ?? "You"}{" "}
        <span style={{ fg: Theme.textMuted }}>({Locale.time(props.message.time.created)})</span>
      </text>
    </box>
  )
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[] }) {
  return (
    <For each={props.parts}>
      {(part) => {
        const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
        return (
          <Show when={component()}>
            <Dynamic component={component()} part={part as any} message={props.message} />
          </Show>
        )
      }}
    </For>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
}

function TextPart(props: { part: TextPart; message: AssistantMessage }) {
  const sync = useSync()
  const agent = createMemo(() => sync.data.agent.find((x) => x.name === props.message.mode)!)
  const local = useLocal()

  return (
    <box paddingLeft={3}>
      <text>{props.part.text.trim()}</text>
      <text>
        <span style={{ fg: local.agent.color(agent().name) }}>{Locale.titlecase(agent().name)}</span>{" "}
        <span style={{ fg: Theme.textMuted }}>{props.message.providerID + "/" + props.message.modelID}</span>
      </text>
    </box>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { part: ToolPart; message: AssistantMessage }) {
  props.part.state.status

  const component = createMemo(() => {
    if (props.part.state.status === "pending") {
      const pending = ToolRegistry.pending(props.part.tool)
      if (!pending) return
      return (
        <text>
          <Dynamic component={pending} state={props.part.state} />
        </text>
      )
    }

    const ready = ToolRegistry.ready(props.part.tool)
    if (!ready) return
    return (
      <Dynamic
        component={ready}
        input={props.part.state.input}
        metadata={props.part.state.metadata}
        output={props.part.state.status === "completed" ? props.part.state.output : undefined}
      />
    )
  })

  return (
    <Show when={component()}>
      <box {...SplitBorder} borderColor={Theme.backgroundPanel}>
        <box paddingTop={1} paddingBottom={1} paddingLeft={2} backgroundColor={Theme.backgroundPanel} gap={1}>
          {component()}
        </box>
      </box>
    </Show>
  )
}

type ToolProps<T extends Tool.Info> = {
  input: Tool.InferParameters<T>
  metadata?: Tool.InferMetadata<T>
  output?: string
}

const ToolRegistry = (() => {
  const state: Record<string, ReturnType<typeof register>> = {}
  function register<T extends Tool.Info>(input: {
    name: string
    pending?: Component<{ state: ToolStatePending }>
    ready?: Component<ToolProps<T>>
  }) {
    state[input.name] = input
    return input
  }
  return {
    register,
    pending(name: string) {
      return state[name]?.pending
    },
    ready(name: string) {
      return state[name]?.ready
    },
  }
})()

ToolRegistry.register<typeof BashTool>({
  name: "bash",
  pending: () => "Writing command...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>Shell {props.input["description"]}</text>
        <box>
          <text>$ {props.input["command"]}</text>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

const syntax = new SyntaxStyle({
  keyword: { fg: RGBA.fromHex(Theme.syntaxKeyword), bold: true },
  string: { fg: RGBA.fromHex(Theme.syntaxString) },
  comment: { fg: RGBA.fromHex(Theme.syntaxComment), italic: true },
  number: { fg: RGBA.fromHex(Theme.syntaxNumber) },
  function: { fg: RGBA.fromHex(Theme.syntaxFunction) },
  type: { fg: RGBA.fromHex(Theme.syntaxType) },
  operator: { fg: RGBA.fromHex(Theme.syntaxOperator) },
  variable: { fg: RGBA.fromHex(Theme.syntaxVariable) },
  bracket: { fg: RGBA.fromHex(Theme.syntaxPunctuation) },
  punctuation: { fg: RGBA.fromHex(Theme.syntaxPunctuation) },
  default: { fg: RGBA.fromHex(Theme.syntaxVariable) },
})

ToolRegistry.register<typeof ReadTool>({
  name: "read",
  pending: () => "Reading file...",
  ready(props) {
    const hast = createMemo(() => {
      const text = props.metadata?.preview ? highlight.highlightHast(props.metadata.preview, highlight.Language.TS) : ""
      const styled = hastToStyledText(text as any, syntax)
      return styled
    })
    return (
      <>
        <text fg={Theme.textMuted}>Read {props.input["filePath"]}</text>
        <box>
          <text>{hast()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof WriteTool>({
  name: "write",
  pending() {
    return "Writing file..."
  },
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>Wrote {props.input.filePath}</text>
        <box>
          <text>{props.input.content || ""}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof GlobTool>({
  name: "glob",
  pending: () => "Finding files...",
  ready(props) {
    const files = createMemo(() => {
      const result = props.output?.split("\n").filter((x) => x) ?? []
      return result.map((file) => path.relative(Instance.directory, file)).join("\n")
    })
    return (
      <>
        <text fg={Theme.textMuted}>Glob {props.input.pattern}</text>
        <box>
          <text>{files()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof GrepTool>({
  name: "grep",
  pending: () => "Searching content...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>Grep {(props.input as any).pattern}</text>
        <box>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof ListTool>({
  name: "list",
  pending: () => "Listing directory...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>List {(props.input as any).path || "."}</text>
        <box>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof TaskTool>({
  name: "task",
  pending: () => "Delegating...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>Task {(props.input as any).description}</text>
        <box>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof WebFetchTool>({
  name: "webfetch",
  pending: () => "Fetching from the web...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>WebFetch {(props.input as any).url}</text>
        <box>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof EditTool>({
  name: "edit",
  pending: () => "Preparing edit...",
  ready(props) {
    const diffContent = createMemo(() => {
      const parsed = props.metadata?.diff ? parsePatch(props.metadata.diff) : []
      const left: string[] = []
      const right: string[] = []

      for (const change of parsed) {
        for (const hunk of change.hunks) {
          for (const line of hunk.lines) {
            const prefix = line[0]
            const rest = line.slice(1)
            switch (prefix) {
              case " ":
                left.push(rest)
                right.push(rest)
                break
              case "+":
                right.push(rest)
                break
              case "-":
                left.push(rest)
                break
            }
          }
        }
      }

      return {
        left,
        right,
      }
    })

    return (
      <>
        <text style={{ fg: Theme.textMuted }}>Edit {props.input.filePath}</text>
        <box flexDirection="row">
          <box flexGrow={1} flexShrink={0}>
            <For each={diffContent().left}>{(line) => <text>{line}</text>}</For>
          </box>
          <box flexGrow={1} flexShrink={0}>
            <For each={diffContent().right}>{(line) => <text>{line}</text>}</For>
          </box>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof PatchTool>({
  name: "patch",
  pending: () => "Preparing patch...",
  ready(props) {
    return (
      <>
        <text fg={Theme.textMuted}>Patch</text>
        <box>
          <text>{props.output?.trim()}</text>
        </box>
      </>
    )
  },
})

ToolRegistry.register<typeof TodoWriteTool>({
  name: "todowrite",
  pending: () => "Planning...",
})
