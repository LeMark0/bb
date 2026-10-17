import { useState } from "react";
import type { ThreadTimelinePendingTodos } from "@bb/domain";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ResponsiveStage } from "./banner-story-stages";
import { ThreadTodoCard } from "./ThreadTodoCard";

export default {
  title: "promptbox/banner/Todo Card",
};

const mixedTodos: ThreadTimelinePendingTodos = {
  sourceSeq: 0,
  updatedAt: 0,
  order: "dependencies",
  items: [
    {
      id: "id:1",
      text: "Read the planning doc",
      status: "completed",
      position: 1,
      after: [],
    },
    {
      id: "id:2",
      text: "Build initial banner shell",
      status: "completed",
      position: 2,
      after: [1],
    },
    {
      id: "id:3",
      text: "Wire pendingTodos from the timeline projection",
      status: "in_progress",
      position: 3,
      after: [2],
    },
    {
      id: "id:4",
      text: "Surface pendingTodos in `bb thread show` and `bb status`",
      status: "pending",
      position: 4,
      after: [3],
    },
    {
      id: "id:5",
      text: "Tighten GET /threads/:id with requirePublicProject",
      status: "pending",
      position: 5,
      after: [1, 2, 3, 4],
    },
  ],
};

const pendingOnlyTodos: ThreadTimelinePendingTodos = {
  sourceSeq: 1,
  updatedAt: 0,
  order: "dependencies-not-provided",
  items: [
    {
      id: "step:0:Create focused Storybook coverage",
      text: "Create focused Storybook coverage",
      status: "pending",
      position: 1,
      after: [],
    },
    {
      id: "step:0:Wire the production prompt stack",
      text: "Wire the production prompt stack",
      status: "pending",
      position: 2,
      after: [],
    },
  ],
};

const unreadableTodos: ThreadTimelinePendingTodos = {
  sourceSeq: 2,
  updatedAt: 0,
  order: "dependencies-invalid",
  items: [
    {
      id: "id:a",
      text: "Migrate the column",
      status: "in_progress",
      position: 1,
      after: [],
    },
    {
      id: "id:b",
      text: "Remove the old column",
      status: "pending",
      position: 2,
      after: [],
    },
  ],
};

function ToggleableTodoCard({
  pendingTodos,
  initiallyExpanded = false,
}: {
  pendingTodos: ThreadTimelinePendingTodos;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <ThreadTodoCard
      pendingTodos={pendingTodos}
      isExpanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    />
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="prompt stack"
        hint="collapsed header shows compact N/M progress; click to expand"
      >
        <ResponsiveStage>
          <ToggleableTodoCard pendingTodos={mixedTodos} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="expanded"
        hint="dependency order with step numbers and prerequisites"
      >
        <ResponsiveStage>
          <ToggleableTodoCard pendingTodos={mixedTodos} initiallyExpanded />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="pending only"
        hint="agent's order when no dependency data is provided"
      >
        <ResponsiveStage>
          <ToggleableTodoCard
            pendingTodos={pendingOnlyTodos}
            initiallyExpanded
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="unreadable dependencies"
        hint="agent's order when dependency data could not be read"
      >
        <ResponsiveStage>
          <ToggleableTodoCard
            pendingTodos={unreadableTodos}
            initiallyExpanded
          />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}
