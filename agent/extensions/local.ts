import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.registerProvider('openai', {
    baseUrl: 'http://eagle.lan:8080/v1',
  });
}
