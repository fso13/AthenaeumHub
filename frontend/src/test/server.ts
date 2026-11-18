import { setupServer } from 'msw/node';
import { createMockDb } from '../mocks/db';
import { createHandlers } from '../mocks/handlers';

export const mockDb = createMockDb();
export const server = setupServer(...createHandlers(mockDb));
