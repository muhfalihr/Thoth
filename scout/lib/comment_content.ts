import { attachVideoOcr } from './ocr_content.ts';

type CommentContentSet = {
  main: Record<string, unknown> & {
    url?: string;
    is_video?: boolean;
  };
  comments: unknown[];
};

type FinalizeOptions = {
  commentsOnly?: boolean;
  attach?: (record: CommentContentSet['main']) => Promise<unknown>;
};

export async function finalizeCommentContentSet<T extends CommentContentSet>(
  contentSet: T,
  options: FinalizeOptions = {},
): Promise<T> {
  if (!options.commentsOnly) {
    await (options.attach ?? attachVideoOcr)(contentSet.main);
  }
  return contentSet;
}
