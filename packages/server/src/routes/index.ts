import type { FastifyPluginAsync } from 'fastify';
import { adminRoutes } from './admin';
import { assignmentRoutes } from './assignments';
import { authRoutes } from './auth';
import { courseRoutes } from './courses';
import { fileApiRoutes } from './files';
import { courseLessonRoutes, lessonRoutes } from './lessons';
import { lcicRoutes } from './lcic';
import { notificationRoutes } from './notifications';
import { roomRoutes } from './rooms';
import { rtcRoutes } from './rtc';

export const apiRoutes: FastifyPluginAsync = async (app) => {
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(roomRoutes, { prefix: '/rooms' });
  await app.register(courseRoutes, { prefix: '/courses' });
  await app.register(courseLessonRoutes, { prefix: '/courses' });
  await app.register(lessonRoutes, { prefix: '/lessons' });
  await app.register(assignmentRoutes, { prefix: '/assignments' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(lcicRoutes, { prefix: '/lcic' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(rtcRoutes, { prefix: '/rtc' });
  await app.register(fileApiRoutes, { prefix: '/files' });
};
