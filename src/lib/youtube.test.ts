import { describe, expect, it } from 'vitest';
import { channelLink, parseYouTubeLink } from './youtube';

describe('parseYouTubeLink', () => {
  it('parses a playlist link that starts at a video', () => {
    expect(parseYouTubeLink('https://www.youtube.com/watch?v=OY0-VNKgLaU&list=PLBB2DDD64CC993989')).toEqual({
      kind: 'playlist',
      listId: 'PLBB2DDD64CC993989',
      videoId: 'OY0-VNKgLaU',
      index: undefined,
    });
  });

  it('parses playlist pages and index', () => {
    expect(parseYouTubeLink('youtube.com/playlist?list=PLabc_123')).toMatchObject({ kind: 'playlist', listId: 'PLabc_123' });
    expect(parseYouTubeLink('https://www.youtube.com/watch?v=OY0-VNKgLaU&list=PLx&index=3')).toMatchObject({ index: 2 });
  });

  it('parses video links in their various forms', () => {
    expect(parseYouTubeLink('https://youtu.be/OY0-VNKgLaU?t=90')).toEqual({ kind: 'video', videoId: 'OY0-VNKgLaU', start: 90 });
    expect(parseYouTubeLink('https://www.youtube.com/watch?v=OY0-VNKgLaU&t=1m30s')).toMatchObject({ start: 90 });
    expect(parseYouTubeLink('https://www.youtube.com/shorts/OY0-VNKgLaU')).toMatchObject({ videoId: 'OY0-VNKgLaU' });
    expect(parseYouTubeLink('https://m.youtube.com/watch?v=OY0-VNKgLaU')).toMatchObject({ videoId: 'OY0-VNKgLaU' });
    expect(parseYouTubeLink('OY0-VNKgLaU')).toMatchObject({ kind: 'video' });
  });

  it('rejects non-YouTube input', () => {
    expect(parseYouTubeLink('https://vimeo.com/123')).toBeNull();
    expect(parseYouTubeLink('hello world')).toBeNull();
    expect(parseYouTubeLink('https://www.youtube.com/')).toBeNull();
  });
});

describe('channel links', () => {
  it('parses handles, which need resolving', () => {
    expect(parseYouTubeLink('https://www.youtube.com/@Jimmy_Broadbent/')).toEqual({
      kind: 'channel',
      path: '/@Jimmy_Broadbent',
      channelId: null,
      includeShorts: false,
    });
    expect(parseYouTubeLink('youtube.com/@Jimmy_Broadbent/videos')).toMatchObject({ path: '/@Jimmy_Broadbent' });
  });

  it('round-trips the stored link with the resolved ID', () => {
    const link = channelLink('/@Jimmy_Broadbent', 'UCq-ylUNa9RoTK5jr6TBOYag', true);
    expect(parseYouTubeLink(link)).toEqual({
      kind: 'channel',
      path: '/@Jimmy_Broadbent',
      channelId: 'UCq-ylUNa9RoTK5jr6TBOYag',
      includeShorts: true,
    });
  });

  it('accepts /channel/ links directly', () => {
    expect(parseYouTubeLink('https://www.youtube.com/channel/UCq-ylUNa9RoTK5jr6TBOYag')).toMatchObject({
      channelId: 'UCq-ylUNa9RoTK5jr6TBOYag',
    });
    expect(parseYouTubeLink('https://www.youtube.com/channel/bogus')).toBeNull();
  });
});
