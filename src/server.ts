import { tool, z } from "agents";
import { AIChatAgent, AIScheduleAgent, createWorkersAiProvider } from "@cloudflare/ai-chat";
import { Ai } from "@cloudflare/ai";
import { D1Database } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { StreamingTextResponse } from "ai";

import { getSchedulePrompt, scheduleSchema, Schedule, generateId } from "./schedule";
import { getSystemPrompt } from "./prompt";

// Barewire & GlobalCheck Imports
import { Barewire } from "@barewire/sdk";
import { GlobalCheckClient } from "@globalcheck/agent-client"; // Placeholder for GlobalCheck SDK

export interface Env {
  AI: Ai;
  DB: D1Database;
  // New environment variables for Barewire and GlobalCheck
  BAREWIRE_API_KEY?: string;
  BAREWIRE_BASE_URL?: string;
  GLOBALCHECK_API_KEY?: string;
  GLOBALCHECK_BASE_URL?: string;
}

// We extend the AIChatAgent to add state management and scheduled tasks
// for Cloudflare Workers. Note that this AIAgent class is specific to
// this starter and not part of the Agents SDK.
class AIAgent extends AIScheduleAgent<Env, string> {
  // In a production app, you'd likely want to fetch from a database
  // For this demo, we store active scheduled tasks in a class property.
  private activeTasks: Record<string, Schedule<string>> = {};

  constructor(chatAgent: AIChatAgent, private db: D1Database) {
    super(chatAgent);
  }

  async loadScheduledTasks(): Promise<Schedule<string>[]> {
    const { results } = await this.db.prepare("SELECT * FROM tasks").all<Schedule<string>>();
    this.activeTasks = Object.fromEntries(results.map((task) => [task.id, task]));
    return results;
  }

  async scheduleTask(task: Schedule<string>): Promise<void> {
    await this.db
      .prepare("INSERT INTO tasks (id, description, cron, date) VALUES (?, ?, ?, ?)")
      .bind(task.id, task.description, task.cron || null, task.date || null)
      .run();

    this.activeTasks[task.id] = task;

    // Send an immediate message to the client indicating the task was scheduled
    this.broadcast(
      JSON.stringify({ type: "scheduled-task-added", description: task.description, id: task.id })
    );
  }

  async cancelScheduledTask(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM tasks WHERE id = ?").bind(id).run();
    delete this.activeTasks[id];

    // Send an immediate message to the client indicating the task was cancelled
    this.broadcast(JSON.stringify({ type: "scheduled-task-cancelled", id }));
  }

  async executeTask(description: string, task: Schedule<string>) {
    // Do the actual work
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients
    this.broadcast(
      JSON.stringify({ type: "scheduled-task", description, timestamp: new Date().toISOString() })
    );

    // In a real app, you might want to save the task completion or delete it
    if (!task.cron) {
      await this.cancelScheduledTask(task.id);
    }
  }
}

const router = new Hono<Env>();

router.get("/", (c) => c.json({ status: "ok" }));

router.post("/chat", async (c) => {
  const { messages, debug, tools: enabledTools } = await c.req.json();
  const env = c.env;

  // Initialize Barewire SDK to wrap fetch for LLM calls.
  // This ensures all LLM interactions are observed and managed by Barewire.
  const barewireFetch = Barewire.wrapFetch(fetch, {
    apiKey: env.BAREWIRE_API_KEY,
    baseUrl: env.BAREWIRE_BASE_URL,
    serviceName: 'cloudflare-agents-starter-llm', // Identify this service in Barewire
    // Add other Barewire configuration here as needed.
    // Example: headers, tags, etc.
  });

  // Initialize GlobalCheck compliance client.
  // This client can be used to perform checks on prompts and responses.
  const globalCheckClient = new GlobalCheckClient({
    apiKey: env.GLOBALCHECK_API_KEY,
    baseUrl: env.GLOBALCHECK_BASE_URL,
    // Add other GlobalCheck configuration here.
  });

  // --- Example: How to use GlobalCheck to pre-screen prompts ---
  // if (messages.length > 0) {
  //   const lastUserMessage = messages[messages.length - 1];
  //   if (lastUserMessage.role === 'user' && lastUserMessage.content) {
  //     const complianceResult = await globalCheckClient.checkPrompt(lastUserMessage.content);
  //     console.log('GlobalCheck prompt check result:', complianceResult);
  //     // Example: if (!complianceResult.approved) { throw new Error('Prompt violates policy'); }
  //   }
  // }
  // -----------------------------------------------------------------

  const agent = new AIAgent(
    new AIChatAgent({
      llm: createWorkersAiProvider({ binding: env.AI, fetch: barewireFetch }), // Pass the Barewire-wrapped fetch
      system: getSystemPrompt(debug),
      tools: {
        // Server-side auto-execute tool
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("The city to get the weather for"),
          }),
          execute: async ({ city }) => {
            // In a production app, you'd replace this with a real weather API call
            console.log(`Getting weather for ${city}`);
            const temperature = (Math.random() * 20 + 10).toFixed(1);
            const description = Math.random() > 0.5 ? "sunny" : "cloudy";
            return { city, temperature, description };
          },
        }),

        // Client-side tool (browser provides the answer)
        getTimezone: tool({
          description: "Get the current timezone of the user's browser",
          inputSchema: z.object({}),
        }),

        // Approval tool (asks the user before running)
        calculate: tool({
          description: "Perform a calculation",
          inputSchema: z.object({
            expression: z.string().describe("The mathematical expression to calculate"),
          }),
          needsApproval: async (input) => {
            // In a real app, you might have more sophisticated approval logic
            return true;
          },
          execute: async ({ expression }) => {
            try {
              const result = eval(expression); // UNSAFE: Do not use eval in production
              return { result };
            } catch (error) {
              return { error: `Invalid expression: ${expression}` };
            }
          },
        }),

        // Scheduled tasks
        scheduleTask: tool({
          description: getSchedulePrompt(await env.DB.prepare("SELECT * FROM tasks").all<Schedule<string>>()),
          inputSchema: scheduleSchema,
          execute: async (input) => {
            const id = generateId();
            await agent.scheduleTask({ id, ...input });
            return { id, message: `Task '${input.description}' scheduled successfully.` };
          },
        }),

        getScheduledTasks: tool({
          description: "List all currently scheduled tasks",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = await agent.loadScheduledTasks();
            return { tasks };
          },
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            id: z.string().describe("The ID of the task to cancel"),
          }),
          execute: async ({ id }) => {
            await agent.cancelScheduledTask(id);
            return { message: `Task ${id} cancelled.` };
          },
        }),
      },
    }),
    env.DB
  );

  const stream = await agent.run(messages, { debug });

  // --- Example: How to use GlobalCheck to post-screen responses ---
  // You might collect the entire stream content here and then check it:
  // const fullResponse = await stream.readAllText(); // Hypothetical way to read stream
  // const responseComplianceResult = await globalCheckClient.checkResponse(fullResponse);
  // console.log('GlobalCheck response check result:', responseComplianceResult);
  // Then stream the fullResponse back.
  // For simplicity, we stream directly below, but for full post-screening,
  // you'd buffer the response.
  // -----------------------------------------------------------------

  return new StreamingTextResponse(stream);
});

// We use a custom fetch handler to bootstrap the WebSocket connection
// and handle scheduled task execution
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handles HTTP requests for /chat
    const response = await router.fetch(request, env, ctx);
    if (response.status !== 404) {
      return response;
    }

    // This is the WebSocket connection for real-time updates and scheduling.
    // Note: This AIChatAgent instance is for WebSocket handling and likely doesn't make LLM calls itself.
    // If it were to make LLM calls, you would also pass barewireFetch here.
    const agent = new AIAgent(
      new AIChatAgent({
        llm: createWorkersAiProvider({ binding: env.AI }),
        system: getSystemPrompt(false),
        tools: {},
      }),
      env.DB
    );

    // The handleWebsocket method takes care of upgrades and message handling
    return agent.handleWebsocket(request, env.DB);
  },

  // The scheduled method is called by Cloudflare Workers cron triggers
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Instantiate the agent to access task execution logic
    // Note: This AIChatAgent instance is for task scheduling and likely doesn't make LLM calls itself.
    // If it were to make LLM calls, you would also pass barewireFetch here.
    const agent = new AIAgent(
      new AIChatAgent({
        llm: createWorkersAiProvider({ binding: env.AI }),
        system: getSystemPrompt(false),
        tools: {},
      }),
      env.DB
    );

    // Load all tasks from the DB and execute due ones
    const tasks = await agent.loadScheduledTasks();
    for (const task of tasks) {
      if (agent.isDue(task, event.cron)) {
        ctx.waitUntil(agent.executeTask(task.description, task));
      }
    }
  },
};
