import { createCodePlugin } from '@streamdown/code'
import { mermaid } from '@streamdown/mermaid'
import { Streamdown, type ThemeInput } from 'streamdown'
import 'streamdown/styles.css'
import './StreamdownText.css'

const shikiTheme: [ThemeInput, ThemeInput] = ['github-light', 'github-dark']

const codePlugin = createCodePlugin({ themes: shikiTheme })

export type StreamdownTextProps = {
  children: string
  /** True when the assistant's last text chunk is streaming. Used for Streamdown animation and unclosed Markdown. */
  isStreaming?: boolean
}

export function StreamdownText({
  children,
  isStreaming = false,
}: StreamdownTextProps) {
  return (
    <div className="chat-streamdown">
      <Streamdown
        mode="streaming"
        isAnimating={isStreaming}
        parseIncompleteMarkdown
        shikiTheme={shikiTheme}
        plugins={{ mermaid, code: codePlugin }}
        className="chat-streamdown__inner"
      >
        {children}
      </Streamdown>
    </div>
  )
}