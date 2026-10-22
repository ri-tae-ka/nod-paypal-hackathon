import mongoose from "mongoose";

export async function connectDb(uri: string) {
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

export function isDbReady() {
  return mongoose.connection.readyState === 1;
}
