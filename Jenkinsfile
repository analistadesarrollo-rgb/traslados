pipeline {
    agent any

    environment {
        APP_NAME = 'transfer-bot'
        APP_IMAGE = 'transfer-bot:v1.0'
        DOCKER_NETWORK = 'red-gane-int'
    }

    stages {
        stage('Copy .env files') {
            steps {
                withCredentials([string(credentialsId: 'ENV_TRANSFER_BOT', variable: 'ENV_TRANSFER_BOT')]) {
                    writeFile file: '.env', text: env.ENV_TRANSFER_BOT
                }
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm ci --omit=dev'
            }
        }

        stage('Docker Compose Down') {
            steps {
                sh 'docker compose down --remove-orphans || true'
            }
        }

        stage('Delete Old Image') {
            steps {
                sh "docker rmi ${APP_IMAGE} || true"
            }
        }

        stage('Docker Compose Up') {
            steps {
                sh 'docker compose up -d --build'
            }
        }

        stage('Verify') {
            steps {
                sh 'sleep 10 && curl -f http://localhost:3000/api/health || exit 1'
            }
        }
    }

    post {
        failure {
            sh 'docker compose logs --tail=50 || true'
        }
    }
}
