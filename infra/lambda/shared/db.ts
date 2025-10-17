import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const USERS_TABLE = process.env.USERS_TABLE || 'PatchToy-Users';
const PROJECTS_TABLE = process.env.PROJECTS_TABLE || 'PatchToy-Projects';

export interface User {
  userId: string;
  email: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

export interface Project {
  projectId: string;
  userId: string;
  username: string; // Denormalized for fast reads
  name: string;
  data: any; // The full project JSON
  isPublic: boolean; // Whether the project is publicly accessible
  createdAt: string;
  updatedAt: string;
}

/**
 * Get user by ID
 */
export async function getUser(userId: string): Promise<User | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: USERS_TABLE,
      Key: { userId },
    })
  );

  return (result.Item as User) || null;
}

/**
 * Get user by email
 */
export async function getUserByEmail(email: string): Promise<User | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: {
        ':email': email,
      },
      Limit: 1,
    })
  );

  return result.Items?.[0] as User || null;
}

/**
 * Get user by username
 */
export async function getUserByUsername(username: string): Promise<User | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: USERS_TABLE,
      IndexName: 'username-index',
      KeyConditionExpression: 'username = :username',
      ExpressionAttributeValues: {
        ':username': username,
      },
      Limit: 1,
    })
  );

  return result.Items?.[0] as User || null;
}

/**
 * Create new user
 */
export async function createUser(user: User): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: USERS_TABLE,
      Item: user,
      ConditionExpression: 'attribute_not_exists(userId)',
    })
  );
}

/**
 * Get project by ID
 */
export async function getProject(projectId: string): Promise<Project | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
    })
  );

  return (result.Item as Project) || null;
}

/**
 * List all projects for a user
 */
export async function listProjects(userId: string): Promise<Project[]> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: PROJECTS_TABLE,
      IndexName: 'userId-updatedAt-index',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ScanIndexForward: false, // Sort by updatedAt descending
    })
  );

  return (result.Items as Project[]) || [];
}

/**
 * Create new project
 */
export async function createProject(project: Project): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: PROJECTS_TABLE,
      Item: project,
    })
  );
}

/**
 * Update project
 */
export async function updateProject(
  projectId: string,
  updates: { name?: string; data?: any; isPublic?: boolean }
): Promise<void> {
  const updateExpressions: string[] = [];
  const expressionAttributeValues: any = {
    ':updatedAt': new Date().toISOString(),
  };
  const expressionAttributeNames: any = {};

  if (updates.name !== undefined) {
    updateExpressions.push('#name = :name');
    expressionAttributeValues[':name'] = updates.name;
    expressionAttributeNames['#name'] = 'name';
  }

  if (updates.data !== undefined) {
    updateExpressions.push('#data = :data');
    expressionAttributeValues[':data'] = updates.data;
    expressionAttributeNames['#data'] = 'data';
  }

  if (updates.isPublic !== undefined) {
    updateExpressions.push('isPublic = :isPublic');
    expressionAttributeValues[':isPublic'] = updates.isPublic;
  }

  updateExpressions.push('updatedAt = :updatedAt');

  await docClient.send(
    new UpdateCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
      UpdateExpression: 'SET ' + updateExpressions.join(', '),
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
    })
  );
}

/**
 * Delete project
 */
export async function deleteProject(projectId: string): Promise<void> {
  await docClient.send(
    new DeleteCommand({
      TableName: PROJECTS_TABLE,
      Key: { projectId },
    })
  );
}
