## 🚀 Getting Started

Follow these steps to download and run the project locally.

### Prerequisites

Install the following software before starting:

- [Node.js](https://nodejs.org/) — includes npm
- [Git](https://git-scm.com/) — to clone the repository

### 1. Clone the Repository

Open a terminal or PowerShell and run:

```bash
git clone https://github.com/Harshini-3008/smart-civic-grievance-platform.git
```

Move into the project directory:

```bash
cd smart-civic-grievance-platform
```

### 2. Install Dependencies

Run this command from the project root directory:

```bash
npm install
```

This installs the Node.js packages required by the application.

### 3. Start the Application

Run the backend using:

```bash
npm start
```

For development, you can use:

```bash
npm run dev
```

The development command uses Nodemon to restart the server when code changes are detected.

### 4. Open the Application

Once the server starts, open your browser and visit the local address configured by the application.

If the frontend is not served automatically by the backend, open `index.html` using a local development server such as the VS Code Live Server extension.

### Troubleshooting

- **Node.js or npm not recognized:** Install Node.js and restart your terminal.
- **Dependency installation errors:** Check your Node.js version and run `npm install` again.
- **Port already in use:** Stop the other process using the port or configure a different port in the server code.

### Notes

- The project uses Node.js and Express for the backend.
- The database uses SQLite through `better-sqlite3`.
- Install dependencies from the repository root, where `package.json` is located.
