// Synthetic one-pixel images. No user files, external decoder or network is needed by the tests.
export const imageFixtures = [
  { extension: '.png', mime: 'image/png', bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQCegBAAFsAPH6cDjBAAAAAElFTkSuQmCC", "base64") },
  { extension: '.jpg', mime: 'image/jpeg', bytes: Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDhKKKK+kPAP//Z", "base64") },
  { extension: '.gif', mime: 'image/gif', bytes: Buffer.from("R0lGODdhAQABAIEAABRQjAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==", "base64") },
  { extension: '.webp', mime: 'image/webp', bytes: Buffer.from("UklGRjgAAABXRUJQVlA4ICwAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+9Ykf/lnz+Gzj3/8guWF1xGAAAA==", "base64") },
  { extension: '.bmp', mime: 'image/bmp', bytes: Buffer.from("Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAADEDgAAxA4AAAAAAAAAAAAAjFAUAA==", "base64") },
];
export const pngFixture = imageFixtures[0].bytes;
