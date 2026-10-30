(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const input = $('#json-input');
  const fileInput = $('#file-input');
  const dropZone = $('#drop-zone');
  const errorBox = $('#input-error');
  const toast = $('#toast');
  let extracted = null;
  let toastTimer = 0;

  const safeText = (value) => value === null || value === undefined || value === '' ? '' : String(value);
  const unique = (values) => [...new Set(values.filter(Boolean))];
  const uniqueAccounts = (values) => {
    const seen = new Set();
    return values.filter((value) => {
      if (!value) return false;
      const key = String(value).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const isObject = (value) => value !== null && typeof value === 'object';

  function allObjects(root) {
    const objects = [];
    const seen = new WeakSet();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < 250000) {
      const value = stack.pop();
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      visited++;
      if (!Array.isArray(value)) objects.push(value);
      const values = Array.isArray(value) ? value : Object.values(value);
      for (let i = values.length - 1; i >= 0; i--) if (isObject(values[i])) stack.push(values[i]);
    }
    return objects;
  }

  function firstValue(object, keys) {
    if (!isObject(object)) return undefined;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function nestedText(value) {
    if (typeof value === 'string') return value;
    if (!isObject(value)) return '';
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.edges)) {
      for (const edge of value.edges) {
        const text = nestedText(edge?.node ?? edge);
        if (text) return text;
      }
    }
    if (Array.isArray(value.items)) {
      for (const item of value.items) {
        const text = nestedText(item);
        if (text) return text;
      }
    }
    return '';
  }

  function captionOf(object) {
    const caption = firstValue(object, ['caption', 'caption_text', 'text', 'edge_media_to_caption', 'accessibility_caption']);
    return nestedText(caption).trim();
  }

  function safeUrl(value) {
    if (typeof value !== 'string') return '';
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch { return ''; }
  }

  function versionList(object, keys) {
    const found = [];
    for (const key of keys) {
      const value = object?.[key];
      if (Array.isArray(value)) found.push(...value);
      else if (isObject(value)) {
        if (Array.isArray(value.candidates)) found.push(...value.candidates);
        if (Array.isArray(value.additional_candidates)) found.push(...value.additional_candidates);
        if (Array.isArray(value.resources)) found.push(...value.resources);
        if (typeof value.url === 'string') found.push(value);
      }
    }
    return found;
  }

  function directResource(object, keys, kind) {
    const raw = versionList(object, keys).map((candidate) => {
      const url = safeUrl(typeof candidate === 'string' ? candidate : candidate?.url ?? candidate?.src);
      if (!url) return null;
      const width = Number(candidate?.width ?? candidate?.config_width ?? candidate?.original_width ?? 0) || 0;
      const height = Number(candidate?.height ?? candidate?.config_height ?? candidate?.original_height ?? 0) || 0;
      const bitrate = Number(candidate?.bitrate ?? candidate?.bandwidth ?? 0) || 0;
      return { url, width, height, bitrate, kind };
    }).filter(Boolean);
    return raw;
  }

  function getMediaSources(object) {
    const images = directResource(object, ['image_versions2', 'display_resources', 'thumbnail_resources', 'candidates', 'image_candidates'], 'image');
    for (const key of ['display_url', 'thumbnail_url', 'thumbnail_src', 'cover_frame_url']) {
      const url = safeUrl(object?.[key]);
      if (url) images.push({ url, width: 0, height: 0, bitrate: 0, kind: 'image' });
    }
    const videos = directResource(object, ['video_versions', 'video_resources'], 'video');
    for (const key of ['video_url', 'video_src']) {
      const url = safeUrl(object?.[key]);
      if (url) videos.push({ url, width: 0, height: 0, bitrate: 0, kind: 'video' });
    }
    const dedupe = (list) => [...new Map(list.map((resource) => [resource.url, resource])).values()];
    return { images: dedupe(images), videos: dedupe(videos) };
  }

  function bestVariant(variants) {
    return [...variants].sort((a, b) => {
      const pixels = (b.width * b.height) - (a.width * a.height);
      return pixels || (b.bitrate - a.bitrate);
    })[0] ?? null;
  }

  function sidecarNodes(object) {
    const edges = object?.edge_sidecar_to_children?.edges ?? object?.carousel_media ?? object?.children;
    if (!Array.isArray(edges)) return [];
    return edges.map((edge) => edge?.node ?? edge?.media ?? edge).filter(isObject);
  }

  function hasMedia(object) {
    const sources = getMediaSources(object);
    return sources.images.length > 0 || sources.videos.length > 0 || sidecarNodes(object).length > 0 || /Graph(Image|Video|Sidecar)/i.test(String(object?.__typename ?? ''));
  }

  function getUsername(value) {
    if (typeof value === 'string') return value.replace(/^@/, '').trim();
    if (!isObject(value)) return '';
    const direct = safeText(firstValue(value, ['username', 'user_name', 'handle', 'instagram_username', 'owner_username'])).replace(/^@/, '').trim();
    if (direct) return direct;
    for (const key of ['user', 'owner', 'account', 'tappable_object', 'object', 'user_info', 'user_data', 'profile', 'instagram_user']) {
      if (isObject(value[key]) && value[key] !== value) {
        const nested = getUsername(value[key]);
        if (nested) return nested;
      }
    }
    return '';
  }

  function tappableAccounts(object) {
    const sources = [];
    const addSource = (value) => {
      if (Array.isArray(value)) sources.push(...value);
      else if (isObject(value)) sources.push(value);
      else if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { sources.push(JSON.parse(trimmed)); } catch { /* Ignore non-JSON sticker text. */ }
        }
      }
    };
    addSource(object?.tappable_objects);
    addSource(object?.caption?.tappable_objects);
    addSource(object?.caption_text?.tappable_objects);
    addSource(object?.story_bloks_stickers);
    const captionEdges = object?.edge_media_to_caption?.edges;
    if (Array.isArray(captionEdges)) for (const edge of captionEdges) addSource(edge?.node?.tappable_objects);

    const names = [];
    const seen = new WeakSet();
    const stack = [...sources];
    const usernameKeys = ['username', 'user_name', 'handle', 'instagram_username', 'owner_username'];
    while (stack.length) {
      const value = stack.pop();
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        stack.push(...value);
        continue;
      }
      const username = firstValue(value, usernameKeys);
      if (typeof username === 'string') {
        const normalized = username.replace(/^@/, '').trim();
        if (/^[A-Za-z0-9._]{1,30}$/.test(normalized)) names.push(normalized);
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) stack.push(...child);
        else if (isObject(child)) stack.push(child);
        else if (typeof child === 'string') {
          const trimmed = child.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { stack.push(JSON.parse(trimmed)); } catch { /* Ignore regular sticker text. */ }
          }
        }
      }
    }
    return uniqueAccounts(names);
  }

  function storyFeedReferences(object) {
    const references = [];
    let storyFeedValue = object?.story_feed_media;
    if (typeof storyFeedValue === 'string') {
      try { storyFeedValue = JSON.parse(storyFeedValue); } catch { return references; }
    }
    if (!isObject(storyFeedValue)) return references;
    const stack = [{ value: storyFeedValue, productType: '' }];
    const seen = new WeakSet();
    while (stack.length) {
      const { value, productType: inheritedProductType } = stack.pop();
      if (!isObject(value) || seen.has(value)) continue;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((child) => stack.push({ value: child, productType: inheritedProductType }));
        continue;
      }
      const productType = safeText(firstValue(value, ['product_type', 'productType']) ?? inheritedProductType).toLowerCase();
      const rawCode = safeText(firstValue(value, ['code', 'shortcode', 'short_code']));
      const fallbackId = safeText(firstValue(value, ['id']));
      const code = rawCode || (/^[A-Za-z0-9_-]{5,}$/.test(fallbackId) && !/^\d+$/.test(fallbackId) ? fallbackId : '');
      if (productType === 'clips' && code) {
        const username = getUsername(value.owner ?? value.user ?? value.author ?? value);
        references.push({
          shortcode: code,
          productType,
          type: 'Reel',
          username: username || null,
          permalink: `https://www.instagram.com/p/${encodeURIComponent(code)}/`
        });
      }
      for (const child of Object.values(value)) {
        if (isObject(child)) stack.push({ value: child, productType });
        else if (typeof child === 'string') {
          const trimmed = child.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { stack.push({ value: JSON.parse(trimmed), productType }); } catch { /* Ignore regular text. */ }
          }
        }
      }
    }
    const seen = new Set();
    return references.filter((reference) => {
      if (seen.has(reference.shortcode)) return false;
      seen.add(reference.shortcode);
      return true;
    });
  }

  function storyFeedMediaContexts(root) {
    const contexts = new WeakMap();
    const stack = [{ value: root, insideStoryFeed: false, context: {} }];
    const seen = new WeakMap();
    while (stack.length) {
      const { value, insideStoryFeed, context } = stack.pop();
      if (!isObject(value)) continue;
      const bit = insideStoryFeed ? 2 : 1;
      const previous = seen.get(value) || 0;
      if (previous & bit) continue;
      seen.set(value, previous | bit);
      if (Array.isArray(value)) {
        value.forEach((child) => stack.push({ value: child, insideStoryFeed, context }));
        continue;
      }
      const nextContext = { ...context };
      const productType = firstValue(value, ['product_type', 'productType']);
      const shortcode = firstValue(value, ['code', 'shortcode', 'short_code']);
      const author = value.owner ?? value.user ?? value.author ?? value.user_info;
      const timestamp = timestampOf(value);
      if (productType !== undefined) nextContext.productType = safeText(productType);
      if (shortcode !== undefined) nextContext.shortcode = safeText(shortcode);
      if (isObject(author) && getUsername(author)) nextContext.author = author;
      if (timestamp) nextContext.timestamp = timestamp;
      if (insideStoryFeed && hasMedia(value)) contexts.set(value, { ...nextContext, storyFeedMention: true });
      for (const [key, child] of Object.entries(value)) {
        if (isObject(child)) stack.push({
          value: child,
          insideStoryFeed: insideStoryFeed || key === 'story_feed_media',
          context: key === 'story_feed_media' ? { ...nextContext, storyFeedMention: true } : nextContext
        });
        else if (typeof child === 'string') {
          const trimmed = child.trim();
          if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try { stack.push({ value: JSON.parse(trimmed), insideStoryFeed: insideStoryFeed || key === 'story_feed_media', context: key === 'story_feed_media' ? { ...nextContext, storyFeedMention: true } : nextContext }); } catch { /* Ignore non-JSON text. */ }
          }
        }
      }
    }
    return contexts;
  }

  function taggedAccounts(object) {
    const names = [];
    const tags = object?.edge_media_to_tagged_user?.edges ?? object?.usertags?.in ?? object?.tagged_users ?? object?.taggedPeople ?? [];
    if (Array.isArray(tags)) for (const tag of tags) {
      const name = getUsername(tag?.node?.user ?? tag?.node ?? tag?.user ?? tag);
      if (name) names.push(name);
    }
    const collaborators = object?.coauthor_producers ?? object?.collaborators ?? [];
    if (Array.isArray(collaborators)) for (const person of collaborators) {
      const name = getUsername(person?.user ?? person);
      if (name) names.push(name);
    }
    return uniqueAccounts(names);
  }

  function ownerOf(object) {
    const candidates = ['owner', 'user', 'author', 'creator', 'user_info', 'owner_info', 'account', 'account_info', 'user_data', 'profile']
      .map((key) => object?.[key]).filter(isObject);
    const nestedOwner = candidates.find((candidate) => getUsername(candidate))
      ?? candidates.find((candidate) => firstValue(candidate, ['id', 'pk', 'user_id', 'instagram_id', 'instagram_user_id']))
      ?? null;
    if (nestedOwner) return nestedOwner;
    if (getUsername(object)) return object;
    const accountId = firstValue(object, ['owner_id', 'user_id', 'owner_pk', 'instagram_user_id']);
    if (accountId !== undefined) return {
      id: accountId,
      username: firstValue(object, ['owner_username', 'user_name']),
      full_name: firstValue(object, ['owner_full_name', 'user_full_name'])
    };
    return {};
  }

  function normalizeAccount(record) {
    if (!isObject(record)) return null;
    const nested = ['user', 'owner', 'account', 'user_info', 'tappable_object']
      .map((key) => record[key]).find(isObject) ?? {};
    const value = (keys) => firstValue(record, keys) ?? firstValue(nested, keys);
    const username = getUsername(record);
    const id = safeText(value(['id', 'pk', 'user_id', 'instagram_id', 'instagram_user_id', 'owner_id']));
    if (!username && !id) return null;
    return {
      username,
      fullName: safeText(value(['full_name', 'fullName', 'name'])),
      id,
      verified: record.is_verified ?? nested.is_verified,
      private: record.is_private ?? nested.is_private,
      profilePicture: safeUrl(value(['profile_pic_url', 'profile_pic_url_hd'])),
      biography: safeText(value(['biography', 'bio'])),
      website: safeUrl(value(['external_url', 'website'])),
      followers: value(['edge_followed_by', 'follower_count'])?.count ?? value(['follower_count']),
      following: value(['edge_follow', 'following_count', 'followee_count'])?.count ?? value(['following_count', 'followee_count']),
      posts: value(['edge_owner_to_timeline_media', 'post_count', 'media_count'])?.count ?? value(['post_count', 'media_count'])
    };
  }

  function mergeAccountRecords(primary, fallback) {
    const merged = { ...(fallback ?? {}) };
    const preferred = normalizeAccount(primary);
    if (preferred) for (const [key, value] of Object.entries(preferred)) {
      if (value !== undefined && value !== null && value !== '') merged[key] = value;
    }
    return Object.keys(merged).length ? merged : null;
  }

  function timestampFromValue(raw, inferred = false) {
    if (raw === undefined || raw === null || raw === '') return null;
    let milliseconds;
    if (typeof raw === 'number' || /^\d{9,13}$/.test(String(raw))) {
      const numeric = Number(raw);
      milliseconds = numeric > 100000000000 ? numeric : numeric * 1000;
    } else {
      milliseconds = Date.parse(String(raw));
    }
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    const seconds = Math.floor(milliseconds / 1000);
    const date = new Date(milliseconds);
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    const display = `${part('hour')}:${part('minute')}, ${part('day')} ${part('month')}, ${part('year')}`;
    const note = inferred ? 'estimated from 24-hour story expiry, ' : '';
    return { seconds, milliseconds, inferred, display: `${display} (${note}UNIX Timestamp ${seconds})` };
  }

  function timestampOf(object) {
    return timestampFromValue(firstValue(object, ['taken_at_timestamp', 'taken_at', 'taken_at_ms', 'timestamp', 'created_time', 'created_at', 'device_timestamp']));
  }

  function storyExpiryOf(object) {
    return timestampFromValue(firstValue(object, ['expiring_at_timestamp', 'expiring_at']));
  }

  function inferredStoryTime(object) {
    const expiry = storyExpiryOf(object);
    return expiry ? timestampFromValue(expiry.milliseconds - 24 * 60 * 60 * 1000, true) : null;
  }

  function collectStoryContextTimes(root, objects, candidates) {
    const times = new WeakMap();
    const mediaObjects = new WeakSet(candidates);
    for (const context of objects) {
      const items = context.items ?? context.reel_items ?? context.stories;
      if (!Array.isArray(items) || items.length !== 1) continue;
      const item = items[0]?.node ?? items[0]?.media ?? items[0];
      const latest = firstValue(context, ['latest_reel_media', 'latest_reel_media_timestamp']);
      const value = timestampOf(context) || timestampFromValue(latest);
      if (isObject(item) && value) times.set(item, value);
    }
    const visit = (value, inherited = null, inReels = false, depth = 0) => {
      if (!isObject(value) || depth > 100) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, inherited, inReels, depth + 1));
        return;
      }
      const direct = timestampOf(value);
      const expiry = storyExpiryOf(value);
      const collections = [value.items, value.reel_items, value.stories].filter(Array.isArray);
      const hasManyStories = collections.some((items) => items.length > 1);
      const singleItemLatest = inReels && collections.some((items) => items.length === 1)
        ? timestampFromValue(firstValue(value, ['latest_reel_media', 'latest_reel_media_timestamp'])) : null;
      const storyContextTime = direct || singleItemLatest;
      const storyTime = expiry ? direct || inferredStoryTime(value)
        : inReels && storyContextTime && !hasManyStories ? storyContextTime : inherited;
      if (mediaObjects.has(value) && !direct && storyTime) times.set(value, storyTime);
      for (const [key, child] of Object.entries(value)) {
        visit(child, storyTime, inReels || key === 'reels_media', depth + 1);
      }
    };
    visit(root);
    return times;
  }

  function findLocation(object) {
    const location = firstValue(object, ['location', 'place', 'venue']);
    if (!isObject(location)) return '';
    const name = safeText(firstValue(location, ['name', 'title', 'address', 'city']));
    const latitude = firstValue(location, ['lat', 'latitude']);
    const longitude = firstValue(location, ['lng', 'longitude', 'lon']);
    const coords = latitude !== undefined && longitude !== undefined ? `${latitude}, ${longitude}` : '';
    return [name, coords].filter(Boolean).join(' · ');
  }

  function commentsOf(object) {
    const source = firstValue(object, ['edge_media_to_parent_comment', 'edge_media_to_comment', 'comments']);
    const edges = Array.isArray(source) ? source : source?.edges ?? source?.items ?? [];
    if (!Array.isArray(edges)) return [];
    return edges.slice(0, 40).map((edge) => edge?.node ?? edge).filter(isObject).map((comment) => {
      const author = getUsername(comment?.owner ?? comment?.user ?? comment?.author);
      const text = safeText(firstValue(comment, ['text', 'content'])).trim();
      return { author, text };
    }).filter((comment) => comment.text || comment.author);
  }

  function audioInfo(object) {
    const metadata = firstValue(object, ['clips_metadata', 'music_metadata', 'audio_metadata', 'music_info']) ?? {};
    const music = metadata?.music_info ?? metadata?.music_asset_info ?? metadata?.original_sound_info ?? metadata;
    const audio = music?.audio_asset ?? music?.audio ?? {};
    const artist = safeText(firstValue(music, ['artist_name', 'artist', 'display_artist'])) || safeText(firstValue(audio, ['artist_name', 'artist']))
      || safeText(firstValue(music?.ig_artist, ['username', 'full_name']));
    const title = safeText(firstValue(music, ['title', 'song_name', 'track_name', 'audio_name'])) || safeText(firstValue(audio, ['title', 'title_name']));
    const original = firstValue(music, ['is_original_audio', 'uses_original_audio']);
    return [title, artist, original === true ? 'Original audio' : ''].filter(Boolean).join(' — ');
  }

  function sponsorshipInfo(object) {
    const value = firstValue(object, ['is_paid_partnership', 'is_ad', 'is_sponsored', 'sponsored', 'branded_content', 'sponsor_tags', 'sponsor']);
    if (value === true) return 'Yes';
    if (value === false || value === undefined || value === null || value === '') return '';
    if (Array.isArray(value)) return value.map((entry) => getUsername(entry?.user ?? entry)).filter(Boolean).map((name) => `@${name}`).join(', ') || 'Yes';
    if (isObject(value)) return getUsername(value) ? `@${getUsername(value)}` : safeText(firstValue(value, ['name', 'title', 'label'])) || 'Yes';
    return safeText(value);
  }

  function remixInfo(object) {
    const value = firstValue(object, ['is_remix', 'remix_info', 'remix_source', 'original_media', 'derived_from']);
    if (value === true) return 'Yes';
    if (!value) return '';
    if (value === false) return 'No';
    if (isObject(value)) {
      const creator = getUsername(value.owner ?? value.user ?? value.author);
      const shortcode = safeText(firstValue(value, ['code', 'shortcode']));
      return [creator ? `@${creator}` : '', shortcode ? `Post ${shortcode}` : ''].filter(Boolean).join(' · ') || 'Remix source included';
    }
    return safeText(value);
  }

  function mediaType(object, videos) {
    const value = firstValue(object, ['media_type', 'product_type', 'type']);
    const type = String(value ?? '').toLowerCase();
    if (videos.length || object?.is_video === true || type === '2' || type.includes('video') || type.includes('reel')) return type.includes('reel') || object?.product_type === 'clips' ? 'Reel / video' : 'Video';
    if (type === '8' || sidecarNodes(object).length) return 'Carousel';
    if (type === 'story') return 'Story';
    return 'Image';
  }

  function normalizeMedia(object, inherited = {}) {
    const sources = getMediaSources(object);
    const owner = ownerOf(object);
    const videos = sources.videos;
    const isVideo = videos.length > 0 || object?.is_video === true || Number(object?.media_type) === 2;
    const variant = isVideo ? bestVariant(videos) ?? bestVariant(sources.images) : bestVariant(sources.images) ?? bestVariant(videos);
    if (!variant) return null;
    const shortcode = safeText(firstValue(object, ['code', 'shortcode', 'short_code'])) || inherited.shortcode || '';
    const rawId = safeText(firstValue(object, ['id', 'pk', 'media_id'])) || variant.url;
    const ownerUsername = getUsername(owner) || inherited.author?.username || '';
    const tagged = taggedAccounts(object);
    const caption = captionOf(object) || inherited.caption || '';
    const timestamp = timestampOf(object) || inherited.timestamp || inferredStoryTime(object);
    const storyExpiry = storyExpiryOf(object) || inherited.storyExpiry || null;
    const pathType = String(object?.product_type ?? inherited.productType ?? '').toLowerCase();
    const storyFeedMention = inherited.storyFeedMention === true;
    const sharedClip = storyFeedMention && (pathType.includes('clips') || pathType.includes('reel') || /reel/i.test(mediaType(object, videos)));
    const family = sharedClip ? 'reel'
      : inherited.family === 'story' || storyExpiry || pathType === 'story' || /story/i.test(String(object?.type ?? '')) ? 'story'
      : inherited.family === 'reel' || pathType.includes('clips') || pathType.includes('reel') || /reel/i.test(mediaType(object, videos)) ? 'reel' : 'post';
    const permalink = storyFeedMention && shortcode
      ? `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`
      : safeUrl(firstValue(object, ['permalink', 'permalink_url'])) || (shortcode ? `https://www.instagram.com/${pathType === 'clips' || pathType === 'reel' ? 'reel' : 'p'}/${encodeURIComponent(shortcode)}/` : '');
    const duration = Number(firstValue(object, ['video_duration', 'duration']) ?? inherited.videoDuration ?? 0) || 0;
    const dimensions = object?.original_width && object?.original_height
      ? { width: Number(object.original_width), height: Number(object.original_height) }
      : object?.dimensions && (object.dimensions.width || object.dimensions.height)
        ? { width: Number(object.dimensions.width) || 0, height: Number(object.dimensions.height) || 0 }
        : { width: variant.width, height: variant.height };
    const hashtags = unique([...caption.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)].map((match) => match[1]));
    const captionMentions = [...caption.matchAll(/(?:^|[^\p{L}\p{N}_.])@([A-Za-z0-9._]{1,30})/g)].map((match) => match[1].replace(/[.]$/, ''));
    const mentionNames = uniqueAccounts([...captionMentions, ...tappableAccounts(object), ...tagged]);
    const mediaIndex = Number(inherited.carouselIndex ?? firstValue(object, ['carousel_index', 'index']) ?? 1) || 1;
    const primaryKey = safeText(firstValue(object, ['id', 'pk', 'media_id'])) || variant.url;
    const userInfo = mergeAccountRecords(owner, inherited.author);
    return {
      key: primaryKey,
      id: safeText(firstValue(object, ['id', 'pk', 'media_id'])) || 'Not provided',
      shortcode: shortcode || 'Not provided',
      author: userInfo,
      caption,
      timestamp,
      permalink,
      type: storyFeedMention && family === 'reel' ? 'Reel / video' : mediaType(object, videos),
      family,
      storyFeedMention,
      storyFeedMentions: storyFeedReferences(object),
      isVideo,
      variant,
      imageVariants: sources.images,
      videoVariants: videos,
      dimensions,
      duration,
      mentions: mentionNames,
      hashtags,
      tagged,
      likes: firstValue(object, ['like_count', 'edge_media_preview_like', 'edge_liked_by'])?.count ?? firstValue(object, ['like_count', 'likes_count']),
      commentsCount: firstValue(object, ['comment_count', 'edge_media_to_parent_comment', 'edge_media_to_comment'])?.count ?? firstValue(object, ['comment_count', 'comments_count']),
      views: firstValue(object, ['view_count', 'play_count', 'video_view_count']),
      location: findLocation(object),
      accessibility: safeText(firstValue(object, ['accessibility_caption', 'alt_text', 'accessibility_text'])) || safeText(firstValue(object?.accessibility_info, ['accessibility_caption', 'alt_text'])),
      audio: audioInfo(object),
      sponsorship: sponsorshipInfo(object),
      remix: remixInfo(object),
      commentsDisabled: firstValue(object, ['comments_disabled', 'commenting_disabled_for_viewer']),
      likeCountsHidden: firstValue(object, ['like_and_view_counts_disabled', 'likes_disabled']),
      productType: safeText(firstValue(object, ['product_type', 'media_type']) ?? inherited.productType) || 'Not provided',
      comments: commentsOf(object),
      mediaIndex,
      containerKey: inherited.containerKey ?? null,
      storyExpiry
    };
  }

  function mediaContextFor(object, fallbackAuthor, storyContextTimes, storyFeedContexts, rootFamily) {
    const storyFeed = storyFeedContexts.get(object) ?? {};
    const productType = safeText(firstValue(object, ['product_type']) ?? storyFeed.productType);
    return {
      author: mergeAccountRecords(ownerOf(object), mergeAccountRecords(storyFeed.author, fallbackAuthor)),
      caption: captionOf(object),
      timestamp: timestampOf(object) || storyFeed.timestamp || storyContextTimes.get(object),
      shortcode: safeText(firstValue(object, ['code', 'shortcode', 'short_code'])) || storyFeed.shortcode || '',
      productType,
      family: storyFeed.storyFeedMention && productType.toLowerCase().includes('clips') ? 'reel' : rootFamily,
      storyFeedMention: storyFeed.storyFeedMention === true,
      videoDuration: Number(object?.video_duration) || 0
    };
  }

  function extract(json) {
    const objects = allObjects(json);
    const candidates = objects.filter(hasMedia);
    const storyContextTimes = collectStoryContextTimes(json, objects, candidates);
    const storyFeedContexts = storyFeedMediaContexts(json);
    const responseType = detectType(json, objects);
    const rootFamily = responseType === 'Story response' ? 'story' : null;
    const results = [];
    const seenMedia = new Set();
    const accountById = new Map();
    for (const record of objects) {
      const account = normalizeAccount(record);
      if (!account?.username || !account.id) continue;
      const score = (account.fullName ? 4 : 0) + (account.profilePicture ? 4 : 0)
        + (account.followers !== undefined ? 4 : 0) + (account.posts !== undefined ? 8 : 0)
        + (account.biography ? 6 : 0);
      const previous = accountById.get(account.id);
      if (!previous || score > previous.score) accountById.set(account.id, { account, score });
    }
    const accountCandidates = [];
    const addAccountCandidate = (record, priority = 0) => {
      if (!isObject(record)) return;
      const direct = normalizeAccount(record);
      const nested = isObject(record.user) ? normalizeAccount(record.user) : null;
      let account = direct?.username ? direct : nested ?? direct;
      if (!account) return;
      if (!account.username && account.id && accountById.has(account.id)) {
        account = mergeAccountRecords(accountById.get(account.id).account, account);
      }
      const completeness = (account.username ? 20 : 0) + (account.id ? 8 : 0) + (account.fullName ? 4 : 0)
        + (account.profilePicture ? 4 : 0) + (account.followers !== undefined ? 4 : 0)
        + (account.following !== undefined ? 2 : 0) + (account.posts !== undefined ? 8 : 0)
        + (account.biography ? 6 : 0) + (account.website ? 2 : 0)
        + (typeof account.verified === 'boolean' ? 1 : 0) + (typeof account.private === 'boolean' ? 1 : 0);
      accountCandidates.push({ account, score: priority + completeness });
    };
    [
      [json?.data?.xdt_shortcode_media?.owner, 120],
      [json?.data?.shortcode_media?.owner, 120],
      [json?.graphql?.shortcode_media?.owner, 120],
      [json?.data?.graphql?.shortcode_media?.owner, 120],
      [json?.data?.reels_media?.[0]?.owner, 120],
      [json?.data?.reels_media?.[0]?.user, 120],
      [json?.graphql?.shortcode_media?.user, 115],
      [json?.user, 50],
      [json?.owner, 50],
      [json?.data?.user, 50],
      [json?.data?.owner, 50],
      [json?.graphql?.user, 50]
    ].forEach(([record, priority]) => addAccountCandidate(record, priority));
    for (const candidate of candidates) addAccountCandidate(ownerOf(candidate), 100);
    for (const record of objects) {
      const hasAccountDetails = ['profile_pic_url', 'profile_pic_url_hd', 'follower_count', 'edge_followed_by', 'edge_owner_to_timeline_media', 'biography', 'is_private', 'is_verified']
        .some((key) => record[key] !== undefined && record[key] !== null);
      if (getUsername(record) && hasAccountDetails) addAccountCandidate(record, 0);
    }
    accountCandidates.sort((a, b) => b.score - a.score);
    const fallbackAuthor = accountCandidates[0]?.account ?? null;
    const sidecarChildIds = new Set();
    const sidecarChildUrls = new Set();
    for (const candidate of candidates) for (const child of sidecarNodes(candidate)) {
      const id = safeText(firstValue(child, ['id', 'pk', 'media_id']));
      if (id && id !== 'Not provided') sidecarChildIds.add(id);
      const sources = getMediaSources(child);
      [...sources.images, ...sources.videos].forEach((resource) => sidecarChildUrls.add(resource.url));
    }
    for (const candidate of candidates) {
      const children = sidecarNodes(candidate);
      const mediaContext = mediaContextFor(candidate, fallbackAuthor, storyContextTimes, storyFeedContexts, rootFamily);
      if (children.length) {
        const inherited = {
          ...mediaContext,
          containerKey: candidate
        };
        children.forEach((child, index) => {
          const media = normalizeMedia(child, { ...inherited, carouselIndex: index + 1 });
          if (!media) return;
          const dedupeKey = `${media.storyFeedMention ? 'story-feed' : media.family}:${media.variant.kind}:${media.variant.url}`;
          if (!seenMedia.has(dedupeKey)) { seenMedia.add(dedupeKey); results.push(media); }
        });
        continue;
      }
      const media = normalizeMedia(candidate, mediaContext);
      if (!media) continue;
      const dedupeKey = `${media.storyFeedMention ? 'story-feed' : media.family}:${media.variant.kind}:${media.variant.url}`;
      if (!seenMedia.has(dedupeKey)) { seenMedia.add(dedupeKey); results.push(media); }
    }

    const detailCandidates = candidates.map((candidate) => {
      const mediaContext = mediaContextFor(candidate, fallbackAuthor, storyContextTimes, storyFeedContexts, rootFamily);
      let media = normalizeMedia(candidate, mediaContext);
      const children = sidecarNodes(candidate);
      if (!media && children.length) {
        const childMedia = children.map((child, index) => normalizeMedia(child, { ...mediaContextFor(child, fallbackAuthor, storyContextTimes, storyFeedContexts, rootFamily), carouselIndex: index + 1 })).find(Boolean);
        if (childMedia) {
          const owner = ownerOf(candidate);
          const parentCaption = captionOf(candidate);
          const shortcode = safeText(firstValue(candidate, ['code', 'shortcode'])) || childMedia.shortcode;
          const parentMentions = [...parentCaption.matchAll(/(?:^|[^\p{L}\p{N}_.])@([A-Za-z0-9._]{1,30})/g)].map((match) => match[1].replace(/[.]$/, ''));
          const parentHashtags = [...parentCaption.matchAll(/(?:^|\s)#([\p{L}\p{N}_]+)/gu)].map((match) => match[1]);
          const parentTagged = taggedAccounts(candidate);
          const parentTappable = tappableAccounts(candidate);
          media = {
            ...childMedia,
            id: safeText(firstValue(candidate, ['id', 'pk', 'media_id'])) || childMedia.id,
            shortcode,
            author: mergeAccountRecords(owner, fallbackAuthor ?? childMedia.author),
            caption: parentCaption || childMedia.caption,
            timestamp: timestampOf(candidate) || storyContextTimes.get(candidate) || childMedia.timestamp,
            permalink: safeUrl(firstValue(candidate, ['permalink', 'permalink_url'])) || childMedia.permalink,
            type: 'Carousel',
            storyFeedMention: mediaContext.storyFeedMention || childMedia.storyFeedMention,
            storyFeedMentions: [...childMedia.storyFeedMentions, ...storyFeedReferences(candidate)],
            mentions: uniqueAccounts([...childMedia.mentions, ...parentMentions, ...parentTappable, ...parentTagged]),
            hashtags: unique([...childMedia.hashtags, ...parentHashtags]),
            tagged: unique([...childMedia.tagged, ...parentTagged])
          };
        }
      }
      return { candidate, media };
    }).filter((entry) => entry.media);
    const posts = [];
    const seenPosts = new Set();
    // Sidecar children are attachments within a carousel post, not separate posts.
    const carouselChildItems = new Set();
    const carouselParents = candidates.filter((candidate) => sidecarNodes(candidate).length);
    carouselParents.forEach((parent) => sidecarNodes(parent).forEach((child) => carouselChildItems.add(child)));
    posts.length = 0;
    for (const { candidate, media } of detailCandidates) {
      if (carouselChildItems.has(candidate) || sidecarChildIds.has(media.id) || sidecarChildUrls.has(media.variant.url)) continue;
      const isContainer = sidecarNodes(candidate).length > 0;
      const itemKey = safeText(firstValue(candidate, ['id', 'pk', 'media_id', 'code', 'shortcode'])) || media.variant.url;
      if (seenPosts.has(itemKey)) continue;
      seenPosts.add(itemKey);
      const attachments = isContainer ? results.filter((item) => item.containerKey === candidate) : [media];
      posts.push({ ...media, attachments: attachments.length ? attachments : [media] });
    }
    if (!posts.length && results.length) posts.push(...results.filter((media) => !media.containerKey).map((media) => ({ ...media, attachments: [media] })));
    const mentionCounts = new Map();
    const hashtagCounts = new Map();
    for (const post of posts) {
      post.mentions.forEach((name) => mentionCounts.set(name, (mentionCounts.get(name) ?? 0) + 1));
      post.hashtags.forEach((tag) => hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1));
    }
    const creator = posts.map((post) => post.author).find((author) => author?.username || author?.id) ?? fallbackAuthor;
    return { posts, media: results, assets: createDownloadAssets(results), creator, mentionCounts, hashtagCounts, jsonType: responseType };
  }

  function detectType(json, objects) {
    if (json?.data?.reels_media || objects.some((object) => Array.isArray(object.items) && object.items.some((item) => item?.expiring_at_timestamp))) return 'Story response';
    if (json?.data?.xdt_api__v1__feed__user_timeline_graphql_connection || objects.some((object) => Array.isArray(object.edges) && object.edges.some((edge) => edge?.node?.taken_at))) return 'Account timeline';
    if (json?.data?.xdt_shortcode_media || objects.some((object) => object.edge_sidecar_to_children)) return 'Post or carousel';
    if (json?.data?.xdt_api__v1__highlights || objects.some((object) => object.highlight_reels)) return 'Highlight response';
    return 'GraphQL response';
  }

  function displayNumber(value) {
    if (value === undefined || value === null || value === '') return '';
    const n = Number(value);
    return Number.isFinite(n) ? new Intl.NumberFormat('en-US').format(n) : safeText(value);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function profileUrl(username) { return `https://www.instagram.com/${encodeURIComponent(username)}/`; }

  function addLinkedNames(parent, names) {
    if (!names.length) { parent.append(element('span', 'no-value', 'None found')); return; }
    const links = element('div', 'mention-links');
    names.forEach((name) => {
      const link = element('a', '', `@${name}`);
      link.href = profileUrl(name);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `Open Instagram profile for ${name} in a new tab`);
      links.append(link);
    });
    parent.append(links);
  }

  function addStoryFeedLinks(parent, references) {
    if (!references?.length) return;
    const line = element('div', 'report-line');
    line.append(element('strong', '', 'Shared post/reel in story: '));
    references.forEach((reference, index) => {
      if (index) line.append(document.createTextNode(' · '));
      const label = [reference.type || 'Post/reel', reference.username ? `@${reference.username}` : '', reference.shortcode].filter(Boolean).join(' ');
      const link = element('a', '', label);
      link.href = reference.permalink;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      line.append(link);
    });
    parent.append(line);
  }

  function addReportSection(container, title, fields) {
    if (!fields.some(([, value]) => Array.isArray(value) ? value.length : value !== undefined && value !== null && value !== '')) return;
    const section = element('section', 'report-section');
    section.append(element('h4', '', title.toUpperCase()));
    const lines = element('div', 'report-lines');
    for (const [label, value, kind] of fields) {
      if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
      const line = element('div', 'report-line');
      const strong = element('strong', '', `${label}: `);
      line.append(strong);
      if (kind === 'names') addLinkedNames(line, value);
      else if (kind === 'url') {
        const link = element('a', '', value);
        link.href = value; link.target = '_blank'; link.rel = 'noopener noreferrer'; line.append(link);
      } else if (kind === 'comments') {
        const summary = element('span');
        summary.textContent = value.map((comment) => `${comment.author ? `@${comment.author}: ` : ''}${comment.text}`).join(' · ');
        line.append(summary);
      } else line.append(document.createTextNode(Array.isArray(value) ? value.join(', ') : String(value)));
      lines.append(line);
    }
    section.append(lines);
    container.append(section);
  }

  function renderReport(data) {
    const preview = $('#report-preview');
    preview.replaceChildren();
    const posts = data.posts;
    const mentionList = [...data.mentionCounts.keys()];
    const hashtagList = [...data.hashtagCounts.keys()].map((tag) => `#${tag}`);
    if (!posts.length) {
      preview.append(element('p', 'no-value', 'No media objects were recognized. The response may use a different GraphQL shape; the available fields are summarized below when detected.'));
      return;
    }
    posts.forEach((post, index) => {
      const title = posts.length > 1 ? `ITEM ${String(index + 1).padStart(2, '0')} / ${post.type}` : post.type;
      const section = element('section', 'report-section');
      section.append(element('h4', '', title.toUpperCase()));
      const lines = element('div', 'report-lines');
      const addLine = (label, value, kind) => {
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
        const line = element('div', 'report-line');
        line.append(element('strong', '', `${label}: `));
        if (kind === 'names') addLinkedNames(line, value);
        else if (kind === 'url') { const a = element('a', '', value); a.href = value; a.target = '_blank'; a.rel = 'noopener noreferrer'; line.append(a); }
        else if (kind === 'comments') line.append(document.createTextNode(value.map((comment) => `${comment.author ? `@${comment.author}: ` : ''}${comment.text}`).join(' · ')));
        else line.append(document.createTextNode(Array.isArray(value) ? value.join(', ') : String(value)));
        lines.append(line);
      };
      const author = post.author;
      if (author) {
        const authorName = author.username ? `@${author.username}${author.fullName ? ` — ${author.fullName}` : ''}` : author.fullName;
        addLine('Author', authorName);
        addLine('Account ID', author.id);
        addLine('Verified', typeof author.verified === 'boolean' ? (author.verified ? 'Yes' : 'No') : '');
        addLine('Private account', typeof author.private === 'boolean' ? (author.private ? 'Yes' : 'No') : '');
        addLine('Followers', displayNumber(author.followers));
        addLine('Following', displayNumber(author.following));
        addLine('Posts', displayNumber(author.posts));
        addLine('Profile picture URL', author.profilePicture, 'url');
        addLine('Bio', author.biography);
        addLine('Website', author.website, 'url');
      }
      addLine('Media ID', post.id);
      addLine('Shortcode', post.shortcode === 'Not provided' ? '' : post.shortcode);
      addLine('Permalink', post.permalink, 'url');
      addLine('Posted at', post.timestamp?.display);
      addLine('Caption', post.caption);
      addLine('Mentions', post.mentions, 'names');
      addLine('Tagged accounts / collaborators', post.tagged, 'names');
      addLine('Hashtags', post.hashtags.map((tag) => `#${tag}`));
      addLine('Media type', post.type);
      addLine('Attachments', post.attachments.map((item) => `${item.type} ${item.mediaIndex || ''}${item.dimensions.width && item.dimensions.height ? ` (${item.dimensions.width} × ${item.dimensions.height})` : ''}`.trim()));
      addLine('Likes', displayNumber(post.likes));
      addLine('Comments', displayNumber(post.commentsCount));
      addLine('Views / plays', displayNumber(post.views));
      addLine('Location', post.location);
      addLine('Accessibility text', post.accessibility);
      addLine('Video duration', post.duration ? `${post.duration} seconds` : '');
      addLine('Audio / music', post.audio);
      addLine('Paid partnership / sponsor', post.sponsorship);
      addLine('Remix source', post.remix);
      addLine('Comments disabled', typeof post.commentsDisabled === 'boolean' ? (post.commentsDisabled ? 'Yes' : 'No') : '');
      addLine('Like / view counts hidden', typeof post.likeCountsHidden === 'boolean' ? (post.likeCountsHidden ? 'Yes' : 'No') : '');
      addLine('Product type', post.productType === 'Not provided' ? '' : post.productType);
      addLine('Top-level comment text', post.comments, 'comments');
      addLine('Story expires at', post.storyExpiry?.display);
      addStoryFeedLinks(lines, post.storyFeedMentions);
      section.append(lines);
      preview.append(section);
    });
    addReportSection(preview, 'Mention index', [['Accounts', mentionList, 'names']]);
    addReportSection(preview, 'Hashtag index', [['Tags', hashtagList]]);
    if (!posts.length && (mentionList.length || hashtagList.length)) return;
  }

  function safeFilePart(value) {
    return safeText(value).replace(/[^a-z0-9._-]+/gi, '_').replace(/^[_ .-]+|[_ .-]+$/g, '').slice(0, 80) || 'instagram-media';
  }

  function extensionFor(url, type) {
    try {
      const path = new URL(url).pathname;
      const match = path.match(/\.([a-z0-9]{2,5})$/i);
      if (match && !['php', 'ashx', 'aspx'].includes(match[1].toLowerCase())) return match[1].toLowerCase();
    } catch { /* URL was already validated. */ }
    return type === 'video' ? 'mp4' : 'jpg';
  }

  function sortableTimestamp(media) {
    if (!media.timestamp?.milliseconds) return 'undated';
    const date = new Date(media.timestamp.milliseconds);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}_${part('hour')}-${part('minute')}-${part('second')}`;
  }

  function sortableDate(milliseconds) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(milliseconds));
    const part = (type) => parts.find((entry) => entry.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function createDownloadAssets(mediaItems) {
    const assets = [];
    const isVideoMedia = (media) => media.isVideo || media.videoVariants.length > 0 || /video|reel/i.test(media.type);
    const videoThumbnailUrls = new Set(mediaItems
      .filter(isVideoMedia)
      .flatMap((media) => media.imageVariants.map((variant) => variant.url)));
    mediaItems.forEach((media, sourceMediaIndex) => {
      const family = media.family || 'post';
      const isVideo = isVideoMedia(media);
      if (isVideo) {
        const video = bestVariant(media.videoVariants) || (media.variant.kind === 'video' ? media.variant : null);
        const thumbnail = bestVariant(media.imageVariants);
        if (video) assets.push({ ...media, family, variant: video, assetKind: 'vid', itemIndex: media.mediaIndex || 1, sourceMediaIndex });
        if (thumbnail) assets.push({ ...media, family, variant: thumbnail, assetKind: 'thb', itemIndex: media.mediaIndex || 1, sourceMediaIndex });
        if (!video && !thumbnail && media.variant) assets.push({ ...media, family, variant: media.variant, assetKind: media.variant.kind === 'video' ? 'vid' : 'thb', itemIndex: media.mediaIndex || 1, sourceMediaIndex });
        return;
      }
      if (videoThumbnailUrls.has(media.variant.url)) return;
      const image = bestVariant(media.imageVariants) || media.variant;
      if (image) assets.push({ ...media, family, variant: image, assetKind: 'img', itemIndex: media.mediaIndex || 1, sourceMediaIndex });
    });
    return assets;
  }

  function filenameHandle(username) {
    return `@${safeFilePart(username || 'unknown-account')}@`;
  }

  function mediaFilename(asset) {
    const family = asset.family || 'post';
    const suffix = family === 'post'
      ? `post-${asset.assetKind}-${asset.itemIndex || 1}`
      : `${family}-${asset.assetKind}`;
    const ext = extensionFor(asset.variant.url, asset.variant.kind);
    return `${sortableTimestamp(asset)}_${filenameHandle(asset.author?.username)}_${suffix}.${ext}`;
  }

  async function fetchMedia(media) {
    const response = await fetch(media.variant.url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok || response.type === 'opaque') throw new Error('This CDN does not allow browser download access.');
    return await response.blob();
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = filename; anchor.style.display = 'none';
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function downloadOne(media, index, button) {
    if (button) { button.disabled = true; button.dataset.oldText = button.textContent; button.textContent = 'Saving…'; }
    try {
      const blob = await fetchMedia(media);
      saveBlob(blob, mediaFilename(media));
      notify('Media file downloaded.');
    } catch {
      notify('Direct download was blocked. Use Open source beside this button to save manually.');
    } finally {
      if (button) { button.disabled = false; button.textContent = button.dataset.oldText || 'Save file'; }
    }
  }

  function wait(milliseconds) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

  async function downloadMediaSequentially() {
    if (!extracted?.assets.length) return;
    const button = $('#sequence-button');
    button.disabled = true;
    const originalText = button.textContent;
    let downloaded = 0;
    let blocked = 0;
    try {
      for (const [index, media] of extracted.assets.entries()) {
        button.textContent = `Saving ${index + 1}/${extracted.assets.length}…`;
        try {
          const blob = await fetchMedia(media);
          saveBlob(blob, mediaFilename(media));
          downloaded++;
          await wait(650);
        } catch { blocked++; }
      }
      if (downloaded) notify(`${downloaded} media file${downloaded === 1 ? '' : 's'} saved${blocked ? `; ${blocked} could not be fetched` : ''}.`);
      else notify('The CDN blocked browser downloads. Use Open source on each file to save manually.');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  function renderMedia(data) {
    const container = $('#media-list');
    container.replaceChildren();
    const mediaList = data.assets;
    $('#media-count').textContent = `${mediaList.length} ${mediaList.length === 1 ? 'file' : 'files'}`;
    $('#media-empty').hidden = mediaList.length > 0;
    $('#sequence-button').disabled = mediaList.length === 0;
    mediaList.forEach((media, index) => {
      const card = element('article', 'media-card');
      const visual = element('div', 'media-visual');
      const previewUrl = media.imageVariants.length ? bestVariant(media.imageVariants).url : media.variant.url;
      const preview = document.createElement('img');
      preview.src = previewUrl; preview.alt = `Preview of ${media.type.toLowerCase()} attachment ${index + 1}`; preview.loading = 'lazy'; preview.referrerPolicy = 'no-referrer';
      preview.addEventListener('error', () => { preview.hidden = true; visual.classList.add('preview-unavailable'); }, { once: true });
      visual.append(preview);
      visual.append(element('span', 'media-type-pill', media.assetKind === 'vid' ? 'VIDEO' : media.assetKind === 'thb' ? 'THUMBNAIL' : 'IMAGE'));
      if (media.variant.width && media.variant.height) visual.append(element('span', 'media-quality', `${media.variant.width} × ${media.variant.height}`));
      card.append(visual);
      const meta = element('div', 'media-meta');
      meta.append(element('div', 'media-title', mediaFilename(media)));
      const details = [media.type, media.variant.width && media.variant.height ? `${media.variant.width} × ${media.variant.height}` : '', media.duration ? `${media.duration}s` : ''].filter(Boolean).join(' · ');
      meta.append(element('div', 'media-dimensions', details || 'Dimensions not provided'));
      const actions = element('div', 'media-actions');
      const download = element('button', 'media-download', 'Save file');
      download.type = 'button'; download.addEventListener('click', () => downloadOne(media, index, download));
      actions.append(download);
      const open = element('a', 'media-open', 'Open source');
      open.href = media.variant.url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.referrerPolicy = 'no-referrer';
      actions.append(open); meta.append(actions); card.append(meta); container.append(card);
    });
  }

  function textReport(data, mediaStatuses = null) {
    const lines = ['INSTAGRAPH — CATEGORIZED EXTRACTION REPORT', `Response type: ${data.jsonType}`, `Generated: ${new Date().toISOString()}`, ''];
    if (data.creator) {
      lines.push('AUTHOR / ACCOUNT');
      if (data.creator.username) lines.push(`Username: @${data.creator.username}`);
      if (data.creator.fullName) lines.push(`Display name: ${data.creator.fullName}`);
      if (data.creator.id) lines.push(`Account ID: ${data.creator.id}`);
      if (typeof data.creator.verified === 'boolean') lines.push(`Verified: ${data.creator.verified ? 'Yes' : 'No'}`);
      if (typeof data.creator.private === 'boolean') lines.push(`Private account: ${data.creator.private ? 'Yes' : 'No'}`);
      if (data.creator.followers !== undefined) lines.push(`Followers: ${displayNumber(data.creator.followers)}`);
      if (data.creator.following !== undefined) lines.push(`Following: ${displayNumber(data.creator.following)}`);
      if (data.creator.posts !== undefined) lines.push(`Posts: ${displayNumber(data.creator.posts)}`);
      if (data.creator.profilePicture) lines.push(`Profile picture URL: ${data.creator.profilePicture}`);
      if (data.creator.biography) lines.push(`Bio: ${data.creator.biography}`);
      if (data.creator.website) lines.push(`Website: ${data.creator.website}`);
      lines.push('');
    }
    data.posts.forEach((post, index) => {
      lines.push(`${data.posts.length > 1 ? `ITEM ${String(index + 1).padStart(2, '0')} — ` : ''}${post.type.toUpperCase()}`);
      if (post.author?.username) lines.push(`Author: @${post.author.username}${post.author.fullName ? ` — ${post.author.fullName}` : ''}`);
      if (post.author?.id) lines.push(`Author account ID: ${post.author.id}`);
      lines.push(`Media ID: ${post.id}`);
      if (post.shortcode !== 'Not provided') lines.push(`Shortcode: ${post.shortcode}`);
      if (post.permalink) lines.push(`Permalink: ${post.permalink}`);
      if (post.timestamp) lines.push(`Posted at: ${post.timestamp.display}`);
      if (post.caption) lines.push(`Caption: ${post.caption}`);
      lines.push(`Mentions: ${post.mentions.length ? post.mentions.map((name) => `@${name}`).join(', ') : 'None found'}`);
      if (post.tagged.length) lines.push(`Tagged accounts / collaborators: ${post.tagged.map((name) => `@${name}`).join(', ')}`);
      if (post.hashtags.length) lines.push(`Hashtags: ${post.hashtags.map((tag) => `#${tag}`).join(', ')}`);
      lines.push(`Attachments: ${post.attachments.map((item) => `${item.type}${item.dimensions.width && item.dimensions.height ? ` (${item.dimensions.width} × ${item.dimensions.height})` : ''}`).join('; ') || 'Not found'}`);
      if (post.likes !== undefined) lines.push(`Likes: ${displayNumber(post.likes)}`);
      if (post.commentsCount !== undefined) lines.push(`Comments: ${displayNumber(post.commentsCount)}`);
      if (post.views !== undefined) lines.push(`Views / plays: ${displayNumber(post.views)}`);
      if (post.location) lines.push(`Location: ${post.location}`);
      if (post.accessibility) lines.push(`Accessibility text: ${post.accessibility}`);
      if (post.duration) lines.push(`Video duration: ${post.duration} seconds`);
      if (post.audio) lines.push(`Audio / music: ${post.audio}`);
      if (post.sponsorship) lines.push(`Paid partnership / sponsor: ${post.sponsorship}`);
      if (post.remix) lines.push(`Remix source: ${post.remix}`);
      if (typeof post.commentsDisabled === 'boolean') lines.push(`Comments disabled: ${post.commentsDisabled ? 'Yes' : 'No'}`);
      if (typeof post.likeCountsHidden === 'boolean') lines.push(`Like / view counts hidden: ${post.likeCountsHidden ? 'Yes' : 'No'}`);
      if (post.productType !== 'Not provided') lines.push(`Product type: ${post.productType}`);
      if (post.comments.length) lines.push(`Top-level comment text: ${post.comments.map((comment) => `${comment.author ? `@${comment.author}: ` : ''}${comment.text}`).join(' | ')}`);
      if (post.storyExpiry) lines.push(`Story expires at: ${post.storyExpiry.display}`);
      if (post.storyFeedMentions?.length) lines.push(`Shared post/reel in story: ${post.storyFeedMentions.map((reference) => `${reference.type} ${reference.shortcode} — ${reference.permalink}`).join('; ')}`);
      lines.push('');
    });
    lines.push('MENTION INDEX');
    lines.push([...data.mentionCounts.entries()].map(([name, count]) => `@${name}${count > 1 ? ` (${count} items)` : ''}`).join(', ') || 'None found');
    lines.push('', 'HASHTAG INDEX');
    lines.push([...data.hashtagCounts.keys()].map((tag) => `#${tag}`).join(', ') || 'None found');
    lines.push('', 'MEDIA FILES');
    data.assets.forEach((media, index) => {
      const status = mediaStatuses?.[index]?.included === false ? 'not bundled (source blocked browser access)' : 'selected source';
      lines.push(`${index + 1}. ${mediaFilename(media)} — ${media.variant.width && media.variant.height ? `${media.variant.width} × ${media.variant.height}` : 'largest available variant'} — ${status} — ${media.variant.url}`);
    });
    lines.push('', 'ABOUT THIS REPORT', 'Only fields included in the supplied GraphQL response can be extracted. This report was generated locally in your browser.');
    return lines.join('\n');
  }

  function downloadReport() {
    if (!extracted) return;
    const blob = new Blob([textReport(extracted)], { type: 'text/plain;charset=utf-8' });
    saveBlob(blob, reportFilename(extracted));
    notify('Categorized report downloaded.');
  }

  function metadataDocument(data, mediaStatuses) {
    const mediaEntries = data.assets.map((media, index) => {
      const included = mediaStatuses[index]?.included === true;
      return {
        file: included ? mediaFilename(media) : null,
        fileName: mediaFilename(media),
        includedInPackage: included,
        sourceUrl: media.variant.url,
        sourceType: media.variant.kind,
        family: media.family,
        assetKind: media.assetKind,
        itemIndex: media.family === 'post' ? media.itemIndex : null,
        selectedVariant: { width: media.variant.width || null, height: media.variant.height || null, bitrate: media.variant.bitrate || null },
        dimensions: { width: media.dimensions.width || null, height: media.dimensions.height || null },
        mediaType: media.type,
        mediaId: media.id,
        shortcode: media.shortcode,
        carouselSlide: media.mediaIndex || null,
        durationSeconds: media.duration || null,
        alternateImageVariants: media.imageVariants.map(({ url, width, height }) => ({ url, width, height })),
        alternateVideoVariants: media.videoVariants.map(({ url, width, height, bitrate }) => ({ url, width, height, bitrate }))
      };
    });
    const mediaIndexByUrl = new Map(data.media.map((media, index) => [media.variant.url, index]));
    return {
      packageFormat: 'InstaGraph post/story/reel archive',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      displayTimezone: 'Asia/Kolkata',
      responseType: data.jsonType,
      sourceJsonIncluded: true,
      creator: data.creator ? {
        username: data.creator.username || null,
        fullName: data.creator.fullName || null,
        userId: data.creator.id || null,
        verified: data.creator.verified ?? null,
        private: data.creator.private ?? null,
        followers: data.creator.followers ?? null,
        following: data.creator.following ?? null,
        posts: data.creator.posts ?? null,
        profilePictureUrl: data.creator.profilePicture || null,
        biography: data.creator.biography || null,
        website: data.creator.website || null
      } : null,
      summary: {
        postOrStoryCount: data.posts.length,
        mediaFileCount: data.assets.length,
        uniqueMentionCount: data.mentionCounts.size,
        uniqueHashtagCount: data.hashtagCounts.size,
        bundledMediaCount: mediaEntries.filter((media) => media.includedInPackage).length,
        mediaNotBundledCount: mediaEntries.filter((media) => !media.includedInPackage).length
      },
      mentions: [...data.mentionCounts.entries()].map(([username, itemCount]) => ({ username, profileUrl: profileUrl(username), itemCount })),
      hashtags: [...data.hashtagCounts.entries()].map(([tag, itemCount]) => ({ tag, itemCount })),
      items: data.posts.map((post) => ({
        itemType: post.type,
        mediaId: post.id,
        shortcode: post.shortcode,
        permalink: post.permalink || null,
        postedAt: post.timestamp ? { localDisplay: post.timestamp.display, unixSeconds: post.timestamp.seconds, isoUtc: new Date(post.timestamp.milliseconds).toISOString(), estimatedFromStoryExpiry: post.timestamp.inferred === true } : null,
        author: post.author ? { username: post.author.username || null, fullName: post.author.fullName || null, userId: post.author.id || null } : null,
        caption: post.caption || null,
        mentions: post.mentions,
        taggedAccountsAndCollaborators: post.tagged,
        hashtags: post.hashtags,
        attachments: post.attachments.map((attachment) => {
          const sourceMediaIndex = mediaIndexByUrl.get(attachment.variant.url);
          if (sourceMediaIndex === undefined) return { sourceUrl: attachment.variant.url, includedInPackage: false };
          const files = data.assets.flatMap((asset, assetIndex) => asset.sourceMediaIndex === sourceMediaIndex ? [{
            file: mediaEntries[assetIndex].file,
            fileName: mediaEntries[assetIndex].fileName,
            assetKind: mediaEntries[assetIndex].assetKind,
            includedInPackage: mediaEntries[assetIndex].includedInPackage
          }] : []);
          return {
            files,
            file: files[0]?.file ?? null,
            fileName: files[0]?.fileName ?? null,
            includedInPackage: files.length > 0 && files.every((file) => file.includedInPackage),
            mediaType: attachment.type,
            width: attachment.dimensions.width || null,
            height: attachment.dimensions.height || null
          };
        }),
        engagement: { likes: post.likes ?? null, comments: post.commentsCount ?? null, viewsOrPlays: post.views ?? null },
        location: post.location || null,
        accessibilityText: post.accessibility || null,
        videoDurationSeconds: post.duration || null,
        audioOrMusic: post.audio || null,
        paidPartnershipOrSponsor: post.sponsorship || null,
        remixSource: post.remix || null,
        commentsDisabled: post.commentsDisabled ?? null,
        likeOrViewCountsHidden: post.likeCountsHidden ?? null,
        productType: post.productType === 'Not provided' ? null : post.productType,
        storyFeedMentions: (post.storyFeedMentions ?? []).map((reference) => ({
          ...reference,
          mediaFiles: data.assets.filter((asset) => asset.storyFeedMention && asset.shortcode === reference.shortcode).map((asset) => mediaFilename(asset))
        })),
        topLevelComments: post.comments,
        storyExpiresAt: post.storyExpiry?.display || null
      })),
      media: mediaEntries
    };
  }

  function packageFilename(data) {
    const dates = [...new Set(data.posts.map((post) => post.timestamp?.milliseconds).filter(Boolean).map(sortableDate))].sort();
    const date = dates.length > 1 ? `${dates[0]}_to_${dates.at(-1)}` : dates[0] || 'undated';
    return `${date}_${filenameHandle(data.creator?.username)}package.zip`;
  }

  function reportFilename(data) {
    return packageFilename(data).replace('package.zip', 'categorized-report.txt');
  }

  async function crc32Blob(blob) {
    let crc = -1;
    const reader = blob.stream().getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
      }
    }
    return (crc ^ -1) >>> 0;
  }

  async function zipBlob(files) {
    const encoder = new TextEncoder();
    const records = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const file of files) {
      const name = encoder.encode(file.name);
      const size = file.blob.size;
      if (size > 0xffffffff || offset + size > 0xffffffff) throw new Error('This archive is larger than the browser ZIP format limit.');
      const crc = await crc32Blob(file.blob);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true); lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, size, true); lv.setUint32(22, size, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true); local.set(name, 30);
      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, size, true); cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true); central.set(name, 46);
      records.push({ local, blob: file.blob, central });
      offset += local.length + size;
    }
    if (records.length > 65535) throw new Error('This archive contains more files than the browser ZIP format supports.');
    const centralSize = records.reduce((sum, record) => sum + record.central.length, 0);
    const centralOffset = offset;
    if (centralOffset + centralSize + 22 > 0xffffffff) throw new Error('This archive is larger than the browser ZIP format limit.');
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, records.length, true); ev.setUint16(10, records.length, true);
    ev.setUint32(12, centralSize, true); ev.setUint32(16, centralOffset, true); ev.setUint16(20, 0, true);
    const parts = [];
    for (const record of records) parts.push(record.local, record.blob);
    for (const record of records) parts.push(record.central);
    parts.push(end);
    return new Blob(parts, { type: 'application/zip' });
  }

  async function downloadPackage() {
    if (!extracted) return;
    const button = $('#package-button');
    button.disabled = true;
    const label = button.querySelector('span');
    const oldText = label.textContent;
    const mediaStatuses = [];
    const files = [];
    for (const [index, media] of extracted.assets.entries()) {
      label.textContent = `Fetching media ${index + 1}/${extracted.assets.length}…`;
      try {
        const blob = await fetchMedia(media);
        files.push({ name: mediaFilename(media), blob });
        mediaStatuses.push({ included: true, fileName: mediaFilename(media) });
      } catch (error) {
        mediaStatuses.push({ included: false, fileName: mediaFilename(media), reason: error.message || 'CDN blocked browser access' });
      }
    }
    try {
      const metadata = metadataDocument(extracted, mediaStatuses);
      const report = textReport(extracted, mediaStatuses);
      const sourceLinks = extracted.assets.map((media, index) => {
        const status = mediaStatuses[index]?.included ? 'INCLUDED' : 'NOT BUNDLED — source blocked browser access';
        return `${String(index + 1).padStart(2, '0')}. ${status}\nFile: ${mediaFilename(media)}\nSource: ${media.variant.url}`;
      }).join('\n\n') || 'No media files were found in this response.';
      const readme = [
        'INSTAGRAPH COMPLETE POST / STORY / REEL PACKAGE', '',
        `Response type: ${extracted.jsonType}`,
        `Account: ${extracted.creator?.username ? `@${extracted.creator.username}` : extracted.creator?.id ? `ID ${extracted.creator.id}` : 'Not identified'}`,
        `Media included: ${mediaStatuses.filter((status) => status.included).length} of ${extracted.assets.length}`,
        '', 'CONTENTS',
        '- media files in the package root: highest-quality image/video files and available video thumbnails',
        '- metadata/graphql-response.json: the original supplied JSON response',
        '- metadata/categorized-report.txt: human-readable categorized details',
        '- metadata/metadata.json: structured extracted information and media manifest',
        '- metadata/media-source-links.txt: source URLs and inclusion status for each media file',
        '- metadata/README.txt: this file', '',
        'Some Instagram CDNs block browser access. Any media that could not be fetched is listed with its source URL in metadata/media-source-links.txt and metadata/metadata.json.',
        'The original JSON response is included so all fields supplied to InstaGraph remain available.'
      ].join('\n');
      const rawJson = extracted.rawJsonText || '{}';
      files.push(
        { name: 'metadata/categorized-report.txt', blob: new Blob([report], { type: 'text/plain;charset=utf-8' }) },
        { name: 'metadata/metadata.json', blob: new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json;charset=utf-8' }) },
        { name: 'metadata/graphql-response.json', blob: new Blob([rawJson], { type: 'application/json;charset=utf-8' }) },
        { name: 'metadata/media-source-links.txt', blob: new Blob([sourceLinks], { type: 'text/plain;charset=utf-8' }) },
        { name: 'metadata/README.txt', blob: new Blob([readme], { type: 'text/plain;charset=utf-8' }) }
      );
      label.textContent = 'Building package…';
      const zip = await zipBlob(files);
      saveBlob(zip, packageFilename(extracted));
      const bundled = mediaStatuses.filter((status) => status.included).length;
      const blocked = mediaStatuses.length - bundled;
      notify(`Complete package downloaded${blocked ? `; ${blocked} media source${blocked === 1 ? '' : 's'} could not be fetched and are listed in the archive` : ''}.`);
    } catch (error) {
      showError(`The package could not be created. ${error.message || 'The response may be too large for this browser.'}`);
    } finally {
      button.disabled = false;
      label.textContent = oldText;
    }
  }

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 3900);
  }

  function showError(message) { errorBox.textContent = message; errorBox.hidden = false; }
  function clearError() { errorBox.textContent = ''; errorBox.hidden = true; }

  function extractCurrent() {
    clearError();
    const raw = input.value.trim();
    if (!raw) { showError('Paste an Instagram GraphQL JSON response or choose a .json file first.'); input.focus(); return; }
    let json;
    try { json = JSON.parse(raw); }
    catch (error) { showError(`This is not valid JSON. ${error.message}`); return; }
    if (!isObject(json)) { showError('The JSON root must be an object or array.'); return; }
    extracted = extract(json);
    extracted.rawJsonText = input.value;
    renderMedia(extracted);
    renderReport(extracted);
    $('#stat-posts').textContent = String(extracted.posts.length);
    $('#stat-assets').textContent = String(extracted.assets.length);
    $('#stat-mentions').textContent = String(extracted.mentionCounts.size);
    $('#stat-hashtags').textContent = String(extracted.hashtagCounts.size);
    const type = extracted.jsonType;
    const postCount = extracted.posts.length;
    $('#result-summary').textContent = `${type} · ${postCount} ${postCount === 1 ? 'item' : 'items'} · ${extracted.assets.length} media ${extracted.assets.length === 1 ? 'file' : 'files'} ready`;
    $('#results').hidden = false;
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function loadFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json' && !file.type.endsWith('+json')) {
      showError('Please choose a JSON file.'); return;
    }
    const reader = new FileReader();
    reader.onload = () => { input.value = String(reader.result ?? ''); $('#file-label').textContent = `Loaded ${file.name} · stays on this device.`; clearError(); };
    reader.onerror = () => showError('The selected file could not be read.');
    reader.readAsText(file);
  }

  $('#extract-button').addEventListener('click', extractCurrent);
  $('#report-button').addEventListener('click', downloadReport);
  $('#package-button').addEventListener('click', downloadPackage);
  $('#sequence-button').addEventListener('click', downloadMediaSequentially);
  $('#clear-button').addEventListener('click', () => {
    input.value = ''; fileInput.value = ''; extracted = null; clearError(); $('#results').hidden = true;
    $('#file-label').textContent = 'Your JSON stays on this device. Nothing is uploaded.'; input.focus();
  });
  fileInput.addEventListener('change', () => loadFile(fileInput.files?.[0]));
  input.addEventListener('input', clearError);
  dropZone.addEventListener('dragover', (event) => { event.preventDefault(); dropZone.classList.add('is-over'); });
  dropZone.addEventListener('dragleave', (event) => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('is-over'); });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault(); dropZone.classList.remove('is-over');
    const file = [...(event.dataTransfer?.files ?? [])].find((item) => item.name.toLowerCase().endsWith('.json') || item.type === 'application/json');
    if (file) loadFile(file); else showError('Drop a JSON file here.');
  });
  input.addEventListener('keydown', (event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') extractCurrent(); });
})();
