import { IconArrowRight, IconBook2, IconHeadset, IconRobot, IconUser, IconWorld } from "@tabler/icons-react";
import { SupportWidgetDemo } from "@/components/support-widget-demo";
import { TemplMark } from "@/components/brand/templ-mark";
import { transactionExample, transactionExampleAuthors } from "@/lib/standalone-trial-example";
import styles from "./landing-story.module.css";

export function LandingStory() {
  return (
    <figure id="how" className={styles.stage} aria-label="Example conversation">
      <div id="story" className={styles.transcript}>
        <div className={styles.markLine} aria-hidden="true"><TemplMark decorative className={styles.mark} /><span /></div>
        <SupportWidgetDemo className={styles.widget} scenario="shared-transaction" presentation
          appearance={{ theme: "light", radius: "soft", accent: { light: "#727272", dark: "#cccccc" } }}>
          <ol className={styles.firstPaint} aria-label="Example messages">
            <li><small>{transactionExampleAuthors.visitor}</small>{transactionExample.question}</li>
            <li><small>{transactionExampleAuthors.team}</small>{transactionExample.reply}</li>
          </ol>
        </SupportWidgetDemo>
      </div>
    </figure>
  );
}

function AnswerRoutes() {
  return (
    <svg className={styles.art} viewBox="0 0 290 132" role="img" aria-label="A visitor asks AI. AI checks the docs or website and replies. When it needs help, it calls staff.">
      <g className={styles.wires}>
        <path d="M40 58 H113 M155 53 C179 53 174 29 196 29 H213 M155 63 C179 63 174 88 196 88 H213" />
        <path className={styles.staffWire} d="M123 75 V97 Q123 105 113 105 H77" />
      </g>
      <g className={styles.signals} aria-hidden="true">
        <circle className={styles.toAI} r="3" /><circle className={styles.toDocs} r="3" />
        <circle className={styles.toSite} r="3" /><circle className={styles.toStaff} r="3" />
      </g>
      <g className={styles.node}>
        <circle cx="31" cy="58" r="15" /><circle className={styles.aiNode} cx="134" cy="58" r="22" />
        <rect x="210" y="14" width="72" height="30" rx="8" />
        <rect x="210" y="73" width="72" height="30" rx="8" />
        <rect x="19" y="92" width="62" height="26" rx="13" />
      </g>
      <g className={styles.graphIcons} aria-hidden="true">
        <IconUser x="22" y="49" width="18" height="18" /><IconRobot x="121" y="45" width="26" height="26" />
        <IconBook2 x="217" y="22" width="15" height="15" /><IconWorld x="216" y="81" width="15" height="15" />
        <IconHeadset x="27" y="98" width="14" height="14" />
      </g>
      <g className={styles.graphLabels}>
        <text x="31" y="85" textAnchor="middle">Visitor</text><text x="141" y="93" textAnchor="middle">AI</text>
        <text x="238" y="33">Docs</text><text x="234" y="92">Website</text><text x="45" y="109">Staff</text>
        <text x="90" y="122" className={styles.branchLabel}>If needed</text>
      </g>
    </svg>
  );
}

function StaffAnswer() {
  return (
    <svg className={styles.art} viewBox="0 0 290 132" role="img" aria-label="The assistant offers a question to a smiling teammate, who shows it the answer.">
      <g className={styles.drawing}>
        <path className={styles.paper} d="M33 114c2-19 12-33 29-37h18c11 1 20 7 26 16l15-6 4 7-22 13c-3 2-7 1-9-1l-10-10v18z" />
        <path className={styles.paper} d="M64 73v9q7 8 15 0v-9" />
        <path className={styles.paper} d="M48 52c0-16 8-26 23-26 14 0 24 10 24 24v12c-1 12-10 20-22 20-13 0-22-10-22-21-7 0-9-9-3-9z" />
        <path className={styles.hair} d="M47 53c-4-6-4-13 0-18 0-7 7-14 15-14 5-6 15-6 20-2 8-2 16 5 16 12 0 6-4 9-10 9-8 0-13-4-16-9-1 7-7 13-14 16v10h-5c-1-3-3-5-6-4z" />
        <path d="M64 51q3-3 6-2m10-1q3-2 6 0m-17 8v2m14-3v2m-7-2 1 5-3 1" />
        <path className={styles.smile} d="M66 65q9 12 18-2-9 5-18 2z" />
        <path d="M44 104l5-9m12-13q9 12 19 1" />
        <path className={styles.paper} d="m119 89 6-7c2-3 5-1 4 1l-2 5 10-4c3-1 4 2 2 4l-13 8z" />
        <path className={styles.paper} d="M192 114v-12l-13-7-12-14 6-5 14 12 16 3h24c9 0 16 7 16 17v6z" />
        <path d="m168 81-7-6 1-7 5 3 3-5 5 4-2 7m26 29v8m34-9v9" />
        <g transform="rotate(-7 217 65)">
          <rect className={styles.paper} x="188" y="45" width="57" height="44" rx="13" />
          <path d="m216 45-2-9 5-5m-31 27h-4v15h4m57-15h4v15h-4" />
          <circle className={styles.accentDot} cx="220" cy="29" r="3.6" />
          <rect className={styles.face} x="194" y="52" width="44" height="24" rx="8" />
          <path className={styles.robotEyes} d="m201 60 8-3m12 3 7 3m-22 1v3m18-1v2" />
          <path d="M212 82q4-3 10 0" />
        </g>
      </g>
      <g className={styles.questionNote}>
        <path d="M150 39h23a4 4 0 0 1 4 4v18l-7-2h-20a4 4 0 0 1-4-4V43a4 4 0 0 1 4-4z" />
        <path className={styles.questionMark} d="M157 46c0-5 8-5 8 0 0 3-4 3-4 6m0 3v.2" />
      </g>
      <g className={styles.answerNote}>
        <path d="M111 57h29q4 0 4 4v12q0 4-4 4h-17l-7 5v-5h-5q-4 0-4-4V61q0-4 4-4z" />
        <path className={styles.answerCheck} d="m114 67 3 3 6-7" />
        <path className={styles.noteLines} d="M129 64h9m-9 6h6" />
      </g>
    </svg>
  );
}

export function SupportStory() {
  return (
    <section id="readers" className={styles.story} aria-labelledby="support-story-title">
      <div className={styles.storyInner}>
        <h2 id="support-story-title">How your team answers</h2>
        <ol className={styles.steps} role="list">
          <li className={styles.step} data-route-step>
            <div className={styles.scene}>
              <div className={styles.guestMessage}>
                <span className={styles.guestAvatar}><IconUser aria-hidden="true" /></span>
                <div className={styles.guestBubble}><strong>Anon</strong><span>Can you help with my deposit?</span></div>
              </div>
            </div>
            <div className={styles.stepCopy}>
              <h3>A visitor asks for help</h3>
              <p>Stay anonymous or share a verified wallet.</p>
            </div>
            <IconArrowRight className={styles.connector} aria-hidden="true" />
          </li>
          <li className={styles.step} data-route-step>
            <div className={styles.scene}>
              <AnswerRoutes />
            </div>
            <div className={styles.stepCopy}>
              <h3>AI looks it up</h3>
              <p>AI answers from your docs or website.</p>
            </div>
            <IconArrowRight className={styles.connector} aria-hidden="true" />
          </li>
          <li className={styles.step} data-route-step>
            <div className={styles.scene}>
              <StaffAnswer />
            </div>
            <div className={styles.stepCopy}>
              <h3>Your team steps in</h3>
              <p>AI can reuse verified staff answers.</p>
            </div>
          </li>
        </ol>
      </div>
    </section>
  );
}
