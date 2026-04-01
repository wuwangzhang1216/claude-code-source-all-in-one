export type ConnectorTextBlock = { type: 'connector_text'; text: string };
export type ConnectorTextDelta = { type: 'connector_text_delta'; text: string };
export function isConnectorTextBlock(_block: unknown): _block is ConnectorTextBlock { return false; }
export function connectorTextBlockCount(_blocks: unknown[]): number { return 0; }
