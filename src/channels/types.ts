export interface Attachment {
  kind: 'photo' | 'document' | 'voice' | 'video' | 'video_note';
  url?: string;
  filePath?: string;
  mimeType?: string;
  filename?: string;
  durationSec?: number;
}

export interface InboundMessage {
  text: string;
  chatKey: string;
  userLabel: string;
  attachments: Attachment[];
  rawMessageId?: string | number;
}

export interface SendOptions {
  parseMode?: 'HTML' | 'Markdown' | 'none';
  replyToMessageId?: string | number;
  silent?: boolean;
}

export interface MessageChannel {
  readonly chatKey: string;
  readonly userLabel: string;
  readonly maxLength: number;

  send(text: string, options?: SendOptions): Promise<void>;
  sendFile(filePath: string, caption?: string): Promise<void>;
  showTyping(): Promise<void>;
}
