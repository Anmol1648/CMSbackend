import { registerPermissions } from '../../core/registry/permissions';
import { registerMenuGroup, registerMenuItems } from '../../core/registry/menu';
import './ai.settings';

registerPermissions({ key: 'ai', label: 'AI', order: 40 }, [
    { resource: 'ai', action: 'setup', label: 'Set up AI: the provider key (and test it)' },
    { resource: 'ai', action: 'usage', label: 'See how much AI the school uses, and by whom' },
    { resource: 'ai', action: 'generate', label: 'Use AI to write questions and suggest chapters' },
]);

registerMenuGroup({ key: 'learning', label: 'Learning', order: 15 });
registerMenuItems([{ key: 'ai-setup', label: 'AI Setup', icon: 'smart_toy', href: '/ai', group: 'learning', order: 90, anyPermission: ['ai.setup', 'ai.usage'] }]);
