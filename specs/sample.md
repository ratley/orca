# Add health check endpoint

Add a /health endpoint to the API that returns 200 OK with JSON { status: 'ok', version: string }.

## Requirements

- GET /health returns 200
- Response: { status: 'ok', version: '1.0.0' }
- No auth required
- Add basic unit test
