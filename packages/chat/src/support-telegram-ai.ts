export type TelegramAiHelpResult = {
  kind: "summary" | "question" | "answer" | "human";
  problem: string;
  answered: string;
  question: string;
  text: string;
  knowledgeChanges: (
    | { kind: "add-faq"; title: string; text: string }
    | { kind: "add-doc"; title: string; url: string }
    | { kind: "deprecate"; sourceId: string; ifUpdatedAt: string }
  )[];
};
export type TelegramAiHelpJob = {
  assist?: true;
  id: string;
  conversation: string;
  revision: number;
  stage: "summary" | "answer";
  status: "pending" | "ready" | "waiting" | "completed";
  latest: { id: string; revision: number };
  handoffAt: string;
  caseSeq: number;
  replies: { actorId: string; text: string }[];
  result?: TelegramAiHelpResult;
};
